"""Outbound worker.

The workstation stops being an API and becomes a worker that reaches out to the
VaultWares API, claims jobs and reports progress. Nothing listens locally.

Why claim rather than be pushed to:

  * The workstation can be off. Jobs queue and run when it comes back, where
    today a push at the wrong moment simply fails.
  * No inbound port, no CORS dance, no mixed-content workaround — all of which
    existed only because the browser was talking to localhost.
  * More than one worker can run without coordination; the API hands each
    claimer a different row.

Everything that genuinely has to be local stays local: yt-dlp with the captured
headers, ffmpeg, the CUDA upscalers, the zip batcher.
"""

from __future__ import annotations

import os
import platform
import signal
import sys
import threading
import time
import traceback
from typing import Any, Dict, Optional

import requests

# Line-buffer the streams, as server.py does. Under NSSM stdout is a file, so
# Python block-buffers it and the log stays empty for ages — which reads as "the
# service is doing nothing" when it is actually working fine.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(line_buffering=True)
        except Exception:
            pass

from ds_config import DEST_DIR, free_bytes
from ds_pipeline import download_and_process
from ds_storage import storage_report, save_config, load_config, configured_remotes
import ds_streams

API_BASE = os.environ.get("VAULTWARES_API_URL", "https://api.vaultwares.ca").rstrip("/")

# Key file, following the same .access convention the rest of the stack uses
# (see RD_TOKEN_PATH in ds_helpers). A file beats a service environment
# variable here: NSSM env vars are awkward to rotate and end up visible in the
# service config, whereas this is one file with its own permissions.
def _default_key_path() -> str:
    """Locate .access relative to the repo, not to the user profile.

    This ran as a Windows service under LocalSystem, where expanduser("~")
    resolves to C:\\WINDOWS\\system32\\config\\systemprofile — so the key was
    looked for somewhere it could never be. Deriving it from this file's
    location works whichever account the service runs as.
    """
    here = os.path.dirname(os.path.abspath(__file__))          # .../python-zipper/dataset_builder
    repos = os.path.dirname(os.path.dirname(here))             # .../Github Repos
    return os.path.join(repos, ".access", "vaultwares_api_key.txt")


API_KEY_PATH = os.environ.get("VAULTWARES_API_KEY_PATH") or _default_key_path()


def _read_api_key() -> str:
    key = os.environ.get("VAULTWARES_API_KEY", "").strip()
    if key:
        return key
    try:
        with open(API_KEY_PATH, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


API_KEY = _read_api_key()
WORKER_NAME = os.environ.get("VW_WORKER_NAME") or f"zipper@{platform.node()}"

POLL_IDLE_SECONDS = float(os.environ.get("VW_WORKER_POLL", "5"))
POLL_BUSY_SECONDS = 0.5

# How often to report disk and remote space.
#
# Deliberately slow. Each report asks every rclone remote how full it is, which
# is a network round trip per provider, and free space on a 5TB drive is not a
# live number. The claim poll runs every few seconds; this rides along with it
# roughly once a minute.
HEARTBEAT_SECONDS = float(os.environ.get("VW_WORKER_HEARTBEAT", "60"))

# Kinds this worker will take on. A probe is answered in seconds; a live stream
# can run for hours, which is why streams are threaded below rather than run
# inline like a batch.
CLAIM_KINDS = [k.strip() for k in os.environ.get(
    "VW_WORKER_KINDS", "batch,stream,probe,preview").split(",") if k.strip()]

MAX_STREAMS = int(os.environ.get("VW_WORKER_MAX_STREAMS", "3"))

# Below this much free space, `sink: auto` pipes a stream straight to the remote
# instead of landing it. Set well above the refuse-work floor: the point is to
# switch strategy while there is still room, not to discover the problem at the
# moment of running out.
RCAT_FREE_FLOOR = int(os.environ.get("PYTHON_ZIPPER_RCAT_FREE_GB", "40")) * 1024 ** 3

_streams: Dict[str, threading.Thread] = {}
_streams_lock = threading.Lock()
# Refuse new work below this much free space rather than discovering it at write
# time. A full disk is what froze the VPS; the guard belongs before dispatch.
MIN_FREE_BYTES = int(os.environ.get("PYTHON_ZIPPER_MIN_FREE_GB", "5")) * 1024 ** 3

_running = True


def _stop(signum, frame):  # noqa: ARG001
    global _running
    _running = False
    print("[Worker] Stop requested; finishing the current job first.")


class ApiError(RuntimeError):
    pass


def _headers() -> Dict[str, str]:
    h = {"Content-Type": "application/json"}
    if API_KEY:
        h["x-api-key"] = API_KEY
    return h


# API traffic must NOT go through the scraping proxy.
#
# Importing ds_pipeline pulls in scraper, which monkey-patches
# requests.Session.request to force every non-localhost call through the Tor
# SOCKS proxy. That is right for fetching media and completely wrong for talking
# to our own API: with the proxy down the call fails outright, and — far worse —
# with the proxy *up* the request reaches the API from a Tor exit node, so the
# trusted-IP check rejects the key and the worker 403s forever for reasons that
# look nothing like the actual cause.
#
# The patch skips any call that already specifies `proxies`, so passing an empty
# mapping opts out. trust_env=False additionally ignores HTTPS_PROXY and friends.
_session = requests.Session()
_session.trust_env = False
_NO_PROXY: Dict[str, str] = {}


def _post(path: str, payload: Any, timeout: int = 30) -> Optional[dict]:
    try:
        r = _session.post(
            f"{API_BASE}{path}", json=payload, headers=_headers(),
            timeout=timeout, proxies=_NO_PROXY,
        )
        if r.status_code == 403:
            raise ApiError("403 from the API — check VAULTWARES_API_KEY and that this host is a trusted IP")
        r.raise_for_status()
        return r.json()
    except ApiError:
        raise
    except Exception as e:
        print(f"[Worker] POST {path} failed: {e}")
        return None


def heartbeat() -> None:
    """Report what this machine has, and pick up any config asked of it.

    Reported inward rather than exposed for scraping, for the same reason jobs
    are claimed rather than pushed: this host may be asleep, behind NAT, or on a
    tailnet the browser cannot reach. The API holds the last-known report, so
    "how full is that disk" has an answer even when the worker is off — and the
    answer says how old it is rather than pretending to be current.

    The response carries the rclone priority the operator has set from the
    extension, which is how a worker nothing can dial into gets reconfigured.
    """
    try:
        report_body = storage_report()
    except Exception as e:
        print(f"[Worker] Could not build a storage report: {e}")
        return

    res = _post("/api/zipper/workers/heartbeat", {
        "worker": WORKER_NAME,
        "host": platform.node(),
        "platform": platform.platform(),
        "dest_dir": os.path.abspath(DEST_DIR),
        "storage": report_body,
    }, timeout=20)
    if not res:
        return

    desired = res.get("rclone") or {}
    if not isinstance(desired, dict) or not desired:
        return

    # Apply only a real change. save_config writes a file, and rewriting it
    # every minute with identical content would churn the disk and make the
    # mtime useless for working out when the policy last actually moved.
    current = load_config()
    remotes = desired.get("remotes")
    enabled = desired.get("enabled")
    if remotes is not None and list(remotes) == list(current.get("remotes") or []):
        remotes = None
    if enabled is not None and bool(enabled) == bool(current.get("enabled")):
        enabled = None
    if remotes is None and enabled is None:
        return

    save_config(remotes=remotes, enabled=enabled)
    print(f"[Worker] Applied rclone config from the API: {load_config()}")


def claim() -> Optional[dict]:
    kinds = list(CLAIM_KINDS)
    # Stop offering to take streams once this machine is already running its
    # share. Claiming one it cannot start would strand the job in 'claimed'
    # until the stale sweep returns it, which looks exactly like a hang.
    with _streams_lock:
        if len(_streams) >= MAX_STREAMS and "stream" in kinds:
            kinds.remove("stream")
    if not kinds:
        return None
    res = _post("/api/zipper/jobs/claim", {"worker": WORKER_NAME, "kinds": kinds})
    return (res or {}).get("job")


def get_job(job_id: str) -> Optional[dict]:
    try:
        r = _session.get(
            f"{API_BASE}/api/zipper/jobs/{job_id}", headers=_headers(),
            timeout=15, proxies=_NO_PROXY,
        )
        r.raise_for_status()
        return (r.json() or {}).get("job")
    except Exception:
        return None


def report(job_id: str, **fields) -> None:
    """Progress doubles as the heartbeat that stops a long job being reclaimed."""
    _post(f"/api/zipper/jobs/{job_id}/progress", fields, timeout=15)


def record_history(job: dict, saved: list[dict]) -> None:
    if not saved:
        return
    _post("/api/zipper/history", saved, timeout=60)


def run_probe(job: dict) -> None:
    """Answer a stream probe.

    The one job kind that returns data rather than files. yt-dlp has to run
    where the captured headers and the session are — the API cannot do it — so
    it goes through the same queue as everything else, and the answer comes back
    on the job row for the extension to read.
    """
    job_id = job["id"]
    links = job.get("links") or []
    if not links:
        report(job_id, status="failed", error="probe job carried no URL")
        return

    report(job_id, status="running", total_links=1)
    options = job.get("options") or {}
    meta = ds_streams.probe_stream(
        links[0], job.get("headers") or {}, options.get("proxy") or None,
    )
    if meta.get("ok"):
        report(job_id, status="completed", progress=100.0, processed_links=1, result=meta)
        print(f"[Worker] probed {links[0][:80]} -> {len(meta.get('formats') or [])} format(s)")
    else:
        report(job_id, status="failed", error=str(meta.get("error"))[:500])


def run_preview(job: dict) -> None:
    """Decode one frame of a stream so the UI can show what it is.

    Answer-shaped like a probe, and for the same reason it cannot happen in the
    browser: a cross-origin video drawn to a canvas taints it, so reading the
    pixels back throws. The frame has to be produced where the headers and
    ffmpeg are.
    """
    job_id = job["id"]
    links = job.get("links") or []
    if not links:
        report(job_id, status="failed", error="preview job carried no URL")
        return

    options = job.get("options") or {}
    report(job_id, status="running", total_links=1)
    out = ds_streams.preview_stream(
        links[0], job.get("headers") or {}, options.get("proxy") or None,
    )
    # A preview that could not be produced completes rather than fails: the
    # reason is the payload, and marking the job failed would put a red row in
    # the downloads list for something nobody asked to download.
    report(job_id, status="completed", progress=100.0, processed_links=1, result=out)
    print(f"[Worker] preview {'ok' if out.get('ok') else 'failed: ' + str(out.get('error'))[:80]}")


def _pick_sink(options: Dict[str, Any]) -> tuple[str, Optional[str]]:
    """Land locally, or pipe straight to a remote?

    `auto` is the interesting one, and it exists because of a specific failure:
    the VPS's landing volume is 50GB, a long live recording can be larger than
    that, and landing-then-moving needs room for the whole file twice over. When
    headroom is short, piping to the remote makes the ceiling the remote's quota
    instead of the disk's.

    It is not the default when there IS room, because piping gives up salvage: a
    dropped connection leaves a truncated remote object, where a local recording
    leaves a `.part` that gets renamed into something playable.
    """
    want = (options.get("sink") or "auto").lower()
    remote = options.get("rcat_remote") or (configured_remotes() or [None])[0]

    if want == "local" or not remote:
        return "local", None
    if want == "rcat":
        return "rcat", remote

    free = free_bytes(ds_streams.STREAMS_DIR)
    if free and free < RCAT_FREE_FLOOR:
        print(f"[Worker] Only {free / 1024**3:.1f} GB free — streaming to {remote} instead of landing it")
        return "rcat", remote
    return "local", None


def run_stream(job: dict) -> None:
    """Record a live stream, reporting progress to the API as it goes."""
    job_id = job["id"]
    links = job.get("links") or []
    if not links:
        report(job_id, status="failed", error="stream job carried no URL")
        return

    options = job.get("options") or {}
    sink, remote = _pick_sink(options)

    # ds_streams speaks the local job store's field names. The API's are
    # different, and pydantic silently drops what it does not recognise — so an
    # untranslated `downloaded_bytes` would not error, it would just quietly
    # never show a byte count. Translate here, once.
    def _update(jid: str, **f: Any) -> None:
        out: Dict[str, Any] = {}
        for src, dst in (("progress", "progress"), ("status", "status"),
                         ("speed", "speed"), ("eta", "eta"),
                         ("downloaded_bytes", "bytes_done"),
                         ("total_bytes", "bytes_total"),
                         ("save_dir", "save_dir")):
            if f.get(src) is not None:
                out[dst] = f[src]
        if out:
            report(jid, **out)

    def _complete(jid: str, archives=None, rclone_complete=False, **_: Any) -> None:
        report(jid, status="completed", progress=100.0, processed_links=1,
               archives=list(archives or []),
               rclone_remotes=[remote] if (rclone_complete and remote) else [])

    def _fail(jid: str, err: Any) -> None:
        report(jid, status="failed", error=str(err)[:500])

    reporter = ds_streams._Reporter(update=_update, complete=_complete, fail=_fail)

    watcher_stop = threading.Event()

    def watch_for_abort() -> None:
        """Stop the recording when the job is aborted from the extension.

        The extension can only write to the API, so an abort is a status change
        on a row — nothing reaches into this machine. Polling the row is how
        that becomes a signal here.
        """
        while not watcher_stop.wait(5.0):
            row = get_job(job_id)
            if row and row.get("status") == "aborted":
                print(f"[Worker] {job_id} aborted from the API; stopping the recording")
                ds_streams.stop_stream(job_id)
                return

    threading.Thread(target=watch_for_abort, daemon=True).start()
    try:
        ds_streams.download_stream(
            job_id,
            links[0],
            job.get("headers") or {},
            options.get("format_id") or None,
            options.get("proxy") or None,
            report=reporter,
            sink=sink,
            rcat_remote=remote,
            title=job.get("title") or "",
        )
    finally:
        watcher_stop.set()
        with _streams_lock:
            _streams.pop(job_id, None)


def run_job(job: dict) -> None:
    job_id = job["id"]
    links = job.get("links") or []
    options = job.get("options") or {}
    page_url = job.get("page_url") or ""

    print(f"[Worker] Claimed {job_id}: {len(links)} link(s) from {job.get('page_domain') or 'unknown'}")

    free = free_bytes(DEST_DIR)
    if free and free < MIN_FREE_BYTES:
        # Refuse rather than half-fill the disk. Naming the number makes it
        # actionable instead of a mystery.
        msg = (f"only {free / 1024**3:.1f} GB free on the download volume, "
               f"below the {MIN_FREE_BYTES / 1024**3:.0f} GB floor")
        print(f"[Worker] Refusing {job_id}: {msg}")
        report(job_id, status="failed", error=msg)
        return

    report(job_id, status="running", total_links=len(links))

    try:
        result = download_and_process(
            page_url,
            links,
            int(options.get("batch_size", 50)),
            bool(options.get("upscale_enabled", False)),
            options.get("upscale_model") or None,
            job_id,
            job.get("headers") or {},
            bool(options.get("rclone_enabled", False)),
            job.get("link_kinds") or {},
        ) or {}

        archives = result.get("archives") or []
        landed = result.get("rclone_remotes") or []
        report(
            job_id,
            status="completed",
            progress=100.0,
            processed_links=len(links),
            archives=archives,
            save_dir=os.path.abspath(DEST_DIR),
            # Empty means the files are still here. That is a different outcome
            # from "moved to Drive", and the job row is the only place the
            # difference is ever recorded.
            rclone_remotes=landed,
        )
        where = ", ".join(landed) if landed else os.path.abspath(DEST_DIR)
        print(f"[Worker] {job_id} completed - {len(archives)} archive(s) -> {where}")
    except Exception as e:
        print(f"[Worker] {job_id} failed: {e}")
        traceback.print_exc()
        report(job_id, status="failed", error=str(e)[:500])


def main() -> int:
    signal.signal(signal.SIGINT, _stop)
    try:
        signal.signal(signal.SIGTERM, _stop)
    except (AttributeError, ValueError):
        pass  # SIGTERM is not deliverable on all Windows setups

    if not API_KEY:
        print("[Worker] No API key. Set VAULTWARES_API_KEY, or write one to:",
              file=sys.stderr)
        print(f"         {API_KEY_PATH}", file=sys.stderr)
        print("         Every call will 403 until then.", file=sys.stderr)

    print(f"[Worker] {WORKER_NAME} -> {API_BASE}")
    print(f"[Worker] Landing downloads in {os.path.abspath(DEST_DIR)}")

    backoff = POLL_IDLE_SECONDS
    last_beat = 0.0
    while _running:
        # Before claiming, not after: a worker that is about to refuse work for
        # lack of space should have said so first, or the panel shows a full
        # disk only once something has already failed on it.
        if time.time() - last_beat >= HEARTBEAT_SECONDS:
            last_beat = time.time()
            try:
                heartbeat()
            except ApiError as e:
                print(f"[Worker] Heartbeat rejected: {e}")
            except Exception as e:
                print(f"[Worker] Heartbeat failed: {e}")

        try:
            job = claim()
        except ApiError as e:
            # An auth failure will not fix itself by retrying quickly; back off
            # so a misconfigured worker does not hammer the API all night.
            print(f"[Worker] {e}")
            time.sleep(min(backoff * 2, 300))
            backoff = min(backoff * 2, 300)
            continue

        backoff = POLL_IDLE_SECONDS
        if not job:
            time.sleep(POLL_IDLE_SECONDS)
            continue

        kind = (job.get("kind") or "batch").lower()
        if kind == "probe":
            run_probe(job)
        elif kind == "preview":
            run_preview(job)
        elif kind == "stream":
            # Threaded, unlike everything else: a live recording runs for as
            # long as the broadcast does, and running it inline would stop this
            # worker claiming anything at all for hours.
            t = threading.Thread(target=run_stream, args=(job,), daemon=True)
            with _streams_lock:
                _streams[job["id"]] = t
            t.start()
        else:
            run_job(job)
        time.sleep(POLL_BUSY_SECONDS)

    print("[Worker] Stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
