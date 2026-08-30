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
import time
import traceback
from typing import Any, Dict, Optional

import requests

from ds_config import DEST_DIR, free_bytes
from ds_pipeline import download_and_process

API_BASE = os.environ.get("VAULTWARES_API_URL", "https://api.vaultwares.ca").rstrip("/")

# Key file, following the same .access convention the rest of the stack uses
# (see RD_TOKEN_PATH in ds_helpers). A file beats a service environment
# variable here: NSSM env vars are awkward to rotate and end up visible in the
# service config, whereas this is one file with its own permissions.
API_KEY_PATH = os.environ.get("VAULTWARES_API_KEY_PATH") or os.path.join(
    os.path.expanduser("~"), "Desktop", "Github Repos", ".access",
    "vaultwares_api_key.txt",
)


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


def _post(path: str, payload: Any, timeout: int = 30) -> Optional[dict]:
    try:
        r = requests.post(f"{API_BASE}{path}", json=payload, headers=_headers(), timeout=timeout)
        if r.status_code == 403:
            raise ApiError("403 from the API — check VAULTWARES_API_KEY and that this host is a trusted IP")
        r.raise_for_status()
        return r.json()
    except ApiError:
        raise
    except Exception as e:
        print(f"[Worker] POST {path} failed: {e}")
        return None


def claim() -> Optional[dict]:
    res = _post("/api/zipper/jobs/claim", {"worker": WORKER_NAME, "kinds": ["batch"]})
    return (res or {}).get("job")


def report(job_id: str, **fields) -> None:
    """Progress doubles as the heartbeat that stops a long job being reclaimed."""
    _post(f"/api/zipper/jobs/{job_id}/progress", fields, timeout=15)


def record_history(job: dict, saved: list[dict]) -> None:
    if not saved:
        return
    _post("/api/zipper/history", saved, timeout=60)


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
        report(
            job_id,
            status="completed",
            progress=100.0,
            processed_links=len(links),
            archives=archives,
            save_dir=os.path.abspath(DEST_DIR),
        )
        print(f"[Worker] {job_id} completed — {len(archives)} archive(s)")
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
    while _running:
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

        run_job(job)
        time.sleep(POLL_BUSY_SECONDS)

    print("[Worker] Stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
