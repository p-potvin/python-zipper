"""
Live-stream download support for the browser extension.

- probe_stream: yt-dlp -j metadata (title, thumbnail, duration, quality formats)
- download_stream: progress-tracked yt-dlp download, killable per job, saved locally
- stop_stream: terminate a running download

Streams are saved to STREAMS_DIR and, unlike the image pipeline, are NOT moved
off to rclone by default (set PYTHON_ZIPPER_STREAM_RCLONE=1 to opt in) so the
file actually persists somewhere the user can open.

Two things are pluggable, because this module is now driven by the outbound
worker as well as by the retired local server:

  * **Where progress goes.** `report=` takes a callable; the default still
    writes to the in-process job store. The worker passes one that POSTs to the
    API, so a stream job is tracked exactly like a batch job.
  * **Where the bytes go.** `sink=` chooses between landing on local disk and
    piping straight to an rclone remote — see `_run_rcat`.
"""

import base64
import os
import re
import json
import signal
import subprocess
import threading
from urllib.parse import urlparse

from ds_helpers import build_ytdlp_header_args, handoff_to_rclone, ytdlp_bin, ffmpeg_location
from ds_jobs import update_job, complete_job, fail_job, get_job

STREAMS_DIR = os.environ.get("PYTHON_ZIPPER_STREAMS_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".downloaded", "streams"
)
STREAMS_DIR = os.path.abspath(STREAMS_DIR)

class _Reporter:
    """Where a running job's state goes.

    The local job store and the API want the same three things said to them —
    progress, completion, failure — so the module talks to this instead of
    importing one of them directly. The default keeps the old behaviour exactly.
    """

    def __init__(self, update=None, complete=None, fail=None):
        self.update = update or update_job
        self.complete = complete or complete_job
        self.fail = fail or fail_job


def _sanitize_title(title):
    if not title:
        return ""
    s = re.sub(r'[\\/*?:"<>|]', '_', title)
    s = re.sub(r'\s+', ' ', s).strip()
    return s[:120]


# Words that mark the end of the useful part of a livestream tab title.
# "Ada Luna's Room - Chaturbate", "Yasmine live now | ...", "SomeName's Cam" all
# carry the identity first and boilerplate after, so the first of these is where
# the name stops being about who is streaming.
_TITLE_CUT_RE = re.compile(r"\b(rooms?|live|cams?)\b", re.I)

# Separators and decoration left dangling once the tail is cut.
_TITLE_TRIM = " \t-–—|·:,~«»\"'"

_TRAILING_POSSESSIVE_RE = re.compile(r"['\u2019]s$", re.I)


def stream_basename(title):
    """The person or channel a stream belongs to, from the tab title.

    Livestream tab titles are overwhelmingly "<who> <noise>": a room word, a
    site name, a viewer count, a status. Cutting at the first of room/live/cam
    keeps the half that identifies the stream and throws away the half that
    changes minute to minute — which matters because that noisy tail is exactly
    what made two recordings of the same person look unrelated on disk.

    Returns "" when the title yields nothing usable, so the caller can fall back
    rather than producing a file called "Stream #01" with no subject.
    """
    if not title:
        return ""
    m = _TITLE_CUT_RE.search(title)
    base = title[:m.start()] if m else title
    base = base.strip(_TITLE_TRIM)
    # The room word is usually possessive — "Ada Luna's Room" — and the
    # apostrophe-s is left behind once the word after it goes.
    base = _TRAILING_POSSESSIVE_RE.sub("", base).strip(_TITLE_TRIM)
    return _sanitize_title(base)


def next_stream_index(directory, base):
    """Next free number for this subject, so repeat recordings do not collide.

    Scanned from disk rather than counted in memory: recordings happen across
    restarts and across workers, and a counter that resets would start
    overwriting the first session every time the service came back.
    """
    highest = 0
    pattern = re.compile(re.escape(base) + r"\s+Stream\s+#(\d+)", re.I)
    try:
        for name in os.listdir(directory):
            m = pattern.match(name)
            if m:
                highest = max(highest, int(m.group(1)))
    except OSError:
        pass
    return highest + 1


def stream_filename(title, directory):
    """`<subject> Stream #dd`, or "" when the title gives us nothing."""
    base = stream_basename(title)
    if not base:
        return ""
    return f"{base} Stream #{next_stream_index(directory, base):02d}"


def _finalize_stream_name(path, job_id):
    if not path or not os.path.exists(path):
        return path
    job = get_job(job_id) or {}
    title = job.get('title') or ''

    # Preferred: the subject out of the tab title, numbered. Falls through to
    # the old behaviour when the title has nothing in it worth keeping.
    clean_title = stream_filename(title, os.path.dirname(path) or STREAMS_DIR)

    if not clean_title:
        clean_title = _sanitize_title(title)
    if not clean_title or clean_title.lower() in ('stream', 'master', 'playlist', 'chunklist', 'index'):
        orig_name = os.path.basename(path)
        clean_title = orig_name
        if clean_title.startswith(f"pzstream_{job_id}_"):
            clean_title = clean_title[len(f"pzstream_{job_id}_"):]
        clean_title = re.sub(r'\s*\[[^\]]+\](?=\.[^.]+$)', '', clean_title)
        clean_title = re.sub(r'\.[^.]+$', '', clean_title)
        clean_title = _sanitize_title(clean_title)

    if not clean_title or clean_title.lower() in ('master', 'index'):
        clean_title = f"stream_{job_id[:12]}"

    ext = os.path.splitext(path)[1] or '.mp4'
    parent_dir = os.path.dirname(path)
    target_path = os.path.join(parent_dir, f"{clean_title}{ext}")

    counter = 1
    while os.path.exists(target_path) and os.path.abspath(target_path) != os.path.abspath(path):
        target_path = os.path.join(parent_dir, f"{clean_title} ({counter}){ext}")
        counter += 1

    try:
        if os.path.abspath(target_path) != os.path.abspath(path):
            os.replace(path, target_path)
            print(f"[Stream] {job_id} renamed -> {os.path.basename(target_path)}")
            return target_path
    except Exception as e:
        print(f"[Stream] {job_id} rename error ({e}); using {path}")
    return path

# Route yt-dlp through the same proxy the browser uses, e.g.
#   set PYTHON_ZIPPER_PROXY=http://10.64.0.1:PORT   (Basic auth: http://user:pass@host:port)
# Bearer-authenticated proxies can't be expressed here — see README.
PROXY = os.environ.get("PYTHON_ZIPPER_PROXY", "").strip()


def _proxy_args(proxy=None):
    p = (proxy or PROXY or "").strip()
    return ["--proxy", p] if p else []

# job_id -> Popen, so a running download can be stopped/killed.
PROCESSES = {}
PROCESSES_LOCK = threading.Lock()
# Jobs the user explicitly stopped — a partial file is still a success (live recs).
STOPPED = set()


def _num(value):
    try:
        f = float(value)
        return f if f == f else None  # reject NaN
    except (TypeError, ValueError):
        return None


def _sanitize_stream_url(url):
    if not isinstance(url, str):
        return None
    candidate = url.strip()
    if not candidate:
        return None
    # Reject obvious command/argument and control-character abuse.
    if candidate.startswith("-"):
        return None
    if any(ch in candidate for ch in ("\r", "\n", "\t")):
        return None
    if re.search(r"[\x00-\x1f\x7f\s]", candidate):
        return None

    parsed = urlparse(candidate)
    if parsed.scheme not in ("http", "https"):
        return None
    if not parsed.netloc:
        return None
    # Disallow embedded credentials and require a valid hostname.
    if parsed.username is not None or parsed.password is not None:
        return None
    if not parsed.hostname:
        return None
    return candidate


def probe_stream(url, headers=None, proxy=None):
    """Return metadata + selectable formats for a stream URL (yt-dlp -j)."""
    safe_url = _sanitize_stream_url(url)
    if not safe_url:
        return {"ok": False, "error": "invalid stream url"}
    cmd = [ytdlp_bin(), "-j", "--no-warnings", "--no-playlist"]
    cmd += _proxy_args(proxy)
    cmd += build_ytdlp_header_args(headers)
    cmd.append(safe_url)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        if result.returncode != 0 or not result.stdout.strip():
            return {"ok": False, "error": (result.stderr or "probe failed").strip()[:500]}
        info = json.loads(result.stdout.strip().splitlines()[0])
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "probe timed out"}
    except FileNotFoundError:
        return {"ok": False, "error": "yt-dlp not installed"}
    except Exception as e:
        return {"ok": False, "error": str(e)[:500]}

    formats = []
    seen = set()
    for f in info.get("formats", []) or []:
        if f.get("vcodec") in (None, "none") and f.get("acodec") in (None, "none"):
            continue
        height = f.get("height")
        fid = f.get("format_id")
        if not fid or fid in seen:
            continue
        seen.add(fid)
        formats.append({
            "format_id": fid,
            "height": height,
            "width": f.get("width"),
            "ext": f.get("ext"),
            "tbr": f.get("tbr"),
            "fps": f.get("fps"),
            "filesize": f.get("filesize") or f.get("filesize_approx"),
            "note": f.get("format_note") or f.get("resolution") or "",
            "vcodec": f.get("vcodec"),
            "acodec": f.get("acodec"),
        })
    # Highest resolution first; audio-only (no height) last.
    formats.sort(key=lambda x: (x["height"] or -1, x["tbr"] or 0), reverse=True)

    return {
        "ok": True,
        "title": info.get("title") or info.get("id"),
        "id": info.get("id"),
        "ext": info.get("ext"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "uploader": info.get("uploader") or info.get("channel"),
        "webpage_url": info.get("webpage_url"),
        "is_live": bool(info.get("is_live")),
        "filesize": info.get("filesize") or info.get("filesize_approx"),
        "formats": formats[:40],
    }


def _is_http(url):
    """HTTP-only ffmpeg options must not be applied to any other input.

    `-headers`, `-user_agent`, `-rw_timeout` and `-http_proxy` belong to the
    HTTP protocol handler. Passing them alongside a local path makes ffmpeg exit
    with a bare "Option not found" before it opens anything, which is an
    exceptionally unhelpful way to discover the mistake.
    """
    return str(url or "").lower().startswith(("http://", "https://"))


def _ffmpeg_header_args(headers):
    """Headers for ffmpeg, which wants them differently from yt-dlp.

    User-Agent and Referer have their own flags and are rejected inside the
    generic `-headers` blob by some builds, so they are split out. The rest go
    as one CRLF-joined string, which is the format ffmpeg's HTTP layer expects.
    """
    args = []
    rest = []
    for name, value in (headers or {}).items():
        if not value:
            continue
        low = name.lower()
        if low == "user-agent":
            args += ["-user_agent", str(value)]
        elif low == "referer":
            args += ["-referer", str(value)]
        else:
            rest.append(f"{name}: {value}")
    if rest:
        args += ["-headers", "\r\n".join(rest) + "\r\n"]
    return args


# Wide enough to recognise the content, small enough that a base64 copy of it is
# a few kilobytes rather than a few hundred.
PREVIEW_WIDTH = int(os.environ.get("PYTHON_ZIPPER_PREVIEW_WIDTH", "320"))
PREVIEW_TIMEOUT = int(os.environ.get("PYTHON_ZIPPER_PREVIEW_TIMEOUT", "25"))


def preview_stream(url, headers=None, proxy=None):
    """Decode one frame of a stream and return it as a JPEG data URL.

    The point is only half the picture. Producing a frame at all requires the
    manifest to parse, a segment to be fetched with these headers, any
    encryption key to be retrievable, and the codec to decode — which is the
    entire surface on which a stream later fails. So a preview that renders is
    strong evidence the recording will start, and a preview that fails carries
    the reason ffmpeg gave, which is far more useful than a missing thumbnail.

    One frame rather than a clip, deliberately: a clip costs an encode pass and
    adds recognisability, not diagnostic power. The failure modes worth catching
    are all upstream of the first decoded frame.
    """
    ff = os.path.join(ffmpeg_location(), "ffmpeg") if ffmpeg_location() else "ffmpeg"
    cmd = [ff, "-nostdin", "-loglevel", "error"]
    if _is_http(url):
        cmd += _ffmpeg_header_args(headers)
        if proxy:
            cmd += ["-http_proxy", proxy]
        # Bounded so a stalled segment fetch cannot outlive the subprocess
        # timeout and leave a process behind. Microseconds, per ffmpeg.
        cmd += ["-rw_timeout", str(PREVIEW_TIMEOUT * 1_000_000)]
    cmd += [
        "-i", url,
        "-frames:v", "1",
        "-vf", f"scale={PREVIEW_WIDTH}:-2",
        "-f", "image2", "-vcodec", "mjpeg", "-q:v", "6",
        "pipe:1",
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, timeout=PREVIEW_TIMEOUT)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"no frame within {PREVIEW_TIMEOUT}s"}
    except FileNotFoundError:
        return {"ok": False, "error": "ffmpeg not installed"}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}

    data = result.stdout or b""
    if result.returncode != 0 or not data:
        err = (result.stderr or b"").decode("utf-8", "replace").strip()
        # ffmpeg's last line is the actionable one; the rest is banner noise.
        last = err.splitlines()[-1] if err else f"ffmpeg exited {result.returncode}"
        return {"ok": False, "error": last[:300]}

    return {
        "ok": True,
        "image": "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii"),
        "bytes": len(data),
    }


def record_with_ffmpeg(job_id, url, headers=None, proxy=None, report=None, out_path=None):
    """Record a manifest with ffmpeg instead of yt-dlp.

    This exists because of a case where the two genuinely disagree. On
    livemediahost, yt-dlp's generic extractor fetches the manifest URL as a
    *webpage* and is answered 403, while ffmpeg fetches the very same URL with
    the very same captured headers and decodes frames from it happily — which we
    know for certain, because the preview thumbnail for that stream works.

    So the failure is not authentication and not an expired token: it is
    something about how yt-dlp asks. Rather than guess at which header it
    normalises differently, fall back to the client we have already proved can
    fetch these.

    `-c copy` throughout: no re-encode, and MPEG-TS stays valid while it is
    still being written, so a recording cut short is still playable — the same
    property `--hls-use-mpegts` buys on the yt-dlp path.
    """
    report = report or _Reporter()
    ff = os.path.join(ffmpeg_location(), "ffmpeg") if ffmpeg_location() else "ffmpeg"

    cmd = [ff, "-nostdin", "-loglevel", "error"]
    if _is_http(url):
        cmd += _ffmpeg_header_args(headers)
        if proxy:
            cmd += ["-http_proxy", proxy]
        cmd += ["-rw_timeout", str(30 * 1_000_000)]
    cmd += [
        "-i", url,
        "-c", "copy",
        "-f", "mpegts",
        # Machine-readable progress on stdout; errors stay on stderr.
        "-progress", "pipe:1", "-y", out_path,
    ]

    print(f"[Stream] {job_id} recording with ffmpeg -> {os.path.basename(out_path)}")
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, encoding="utf-8", errors="replace",
            creationflags=creationflags,
        )
    except FileNotFoundError:
        return False, "ffmpeg not installed"
    except Exception as e:
        return False, str(e)[:300]

    # Registered under the same job id as the yt-dlp path, so Stop reaches
    # whichever client is actually running.
    with PROCESSES_LOCK:
        PROCESSES[job_id] = proc

    try:
        for line in proc.stdout:
            line = line.strip()
            # ffmpeg's -progress output is flat key=value lines. total_size is
            # the only one that means anything for a live capture: there is no
            # duration to measure against, so there is no percentage to report.
            if line.startswith("total_size="):
                try:
                    report.update(job_id, downloaded_bytes=int(line.split("=", 1)[1]))
                except (ValueError, IndexError):
                    pass
    finally:
        proc.wait()
        with PROCESSES_LOCK:
            PROCESSES.pop(job_id, None)

    err = ""
    try:
        err = (proc.stderr.read() or "").strip()
    except Exception:
        pass

    wrote = os.path.exists(out_path) and os.path.getsize(out_path) > 0
    if wrote:
        return True, ""
    return False, (err.splitlines()[-1] if err else f"ffmpeg exited {proc.returncode}")[:300]


def _find_output(prefix):
    if not os.path.isdir(STREAMS_DIR):
        return None
    matches = [
        f for f in os.listdir(STREAMS_DIR)
        if f.startswith(prefix) and not f.endswith(".part") and not f.endswith(".ytdl")
    ]
    if not matches:
        return None
    matches.sort(key=lambda f: os.path.getmtime(os.path.join(STREAMS_DIR, f)), reverse=True)
    return os.path.join(STREAMS_DIR, matches[0])


def _salvage_part(prefix):
    """Rescue a leftover .part after an abrupt end (dropped connection / hard stop).

    With --hls-use-mpegts the partial is a valid MPEG-TS, so renaming it to drop
    the .part yields a playable file instead of losing the whole recording.
    """
    if not os.path.isdir(STREAMS_DIR):
        return None
    parts = [f for f in os.listdir(STREAMS_DIR) if f.startswith(prefix) and f.endswith(".part")]
    if not parts:
        return None
    parts.sort(key=lambda f: os.path.getmtime(os.path.join(STREAMS_DIR, f)), reverse=True)
    src = os.path.join(STREAMS_DIR, parts[0])
    if os.path.getsize(src) == 0:
        return None
    dst = src[:-len(".part")]
    try:
        if os.path.exists(dst):
            dst = f"{dst}.recovered"
        os.replace(src, dst)
        print(f"[Stream] salvaged partial recording -> {os.path.basename(dst)}")
        return dst
    except Exception as e:
        print(f"[Stream] salvage rename failed ({e}); keeping .part")
        return src


def _rcat_target(remote, title, job_id):
    """Object path to write on the remote.

    Numbered against the local streams directory rather than the remote: an
    `rclone lsf` per recording is a network round trip on the hot path, and the
    job id in the name already guarantees uniqueness. The number is there to
    group a subject's recordings readably, not to prevent collisions.
    """
    name = stream_basename(title)
    name = f"{name} Stream #{next_stream_index(STREAMS_DIR, name):02d}" if name else ""
    name = name or _sanitize_title(title) or f"stream_{job_id}"
    base = remote if remote.endswith(("/", ":")) else remote + "/"
    # MPEG-TS because that is what --hls-use-mpegts produces, and it is the only
    # container here that is valid while still being written. An mp4 would need
    # its moov atom finalised at the end, which a pipe can never go back and do.
    return f"{base}{name} [{job_id}].ts"


def _run_rcat(cmd, remote_path, report, job_id, proxy_note=""):
    """Pipe yt-dlp straight to `rclone rcat`, never touching local disk.

    The reason to want this: on a host whose landing volume is 50GB, a long live
    recording can be larger than the disk it is being written to, and landing
    then moving needs room for the whole thing twice over. rcat streams it out
    as it arrives, so the ceiling becomes the remote's quota rather than the
    SSD's.

    What it costs, and why this is not the default:

      * **No salvage.** A dropped connection leaves a truncated object on the
        remote, or nothing. The local path renames the leftover `.part` into a
        playable file — see `_salvage_part` — and that recovery is not possible
        once the bytes have gone out over a pipe.
      * **No resume.** Same reason.
      * **Memory.** rclone buffers a chunk per transfer (`--drive-chunk-size`,
        8MB by default on Drive) rather than the whole object, but it is not
        free.

    So this is chosen when disk headroom is the binding constraint, not
    generally.
    """
    yt = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        bufsize=0,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )
    rc = subprocess.Popen(
        ["rclone", "rcat", remote_path],
        stdin=yt.stdout, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    # Hand the pipe over entirely: without this the parent holds a reader open
    # and rclone never sees EOF, so a finished download hangs forever.
    yt.stdout.close()

    with PROCESSES_LOCK:
        PROCESSES[job_id] = yt

    tail = []
    try:
        for raw in iter(yt.stderr.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if line.startswith("PZPROG:"):
                parts = line[len("PZPROG:"):].split("/")
                if len(parts) == 5:
                    downloaded = _num(parts[0])
                    total = _num(parts[1]) or _num(parts[2])
                    speed = _num(parts[3])
                    eta = _num(parts[4])
                    percent = None
                    if downloaded is not None and total:
                        percent = round(min(100.0, downloaded / total * 100.0), 1)
                    report.update(
                        job_id,
                        progress=percent if percent is not None else 0,
                        downloaded_bytes=int(downloaded) if downloaded else 0,
                        total_bytes=int(total) if total else 0,
                        speed=speed, eta=eta,
                    )
            else:
                tail.append(line)
                if len(tail) > 15:
                    tail.pop(0)
    finally:
        yt.wait()
        rc.wait()
        with PROCESSES_LOCK:
            PROCESSES.pop(job_id, None)

    rc_out = b""
    try:
        rc_out = rc.stdout.read() or b""
    except Exception:
        pass

    was_stopped = job_id in STOPPED
    STOPPED.discard(job_id)

    # rclone's exit code is the one that matters: yt-dlp exiting non-zero after
    # a stopped live recording is normal, but if rcat failed the object on the
    # remote is not usable and calling that success would be a lie.
    if rc.returncode == 0:
        # Split on either separator: the remote paths this builds use "/", but
        # rcat also accepts a plain local path, and on Windows that comes back
        # with a backslash -- which would otherwise leave the parent directory
        # glued to the front of the reported filename.
        head, _, name = remote_path.replace(chr(92), "/").rpartition("/")
        report.update(job_id, save_dir=head or remote_path)
        report.complete(job_id, archives=[name], rclone_complete=True)
        print(f"[Stream] {job_id} streamed -> {remote_path}{proxy_note}")
        return
    if was_stopped:
        report.update(job_id, status="aborted", progress=0)
        print(f"[Stream] {job_id} stopped mid-stream; remote object may be truncated")
        return

    err = (rc_out.decode("utf-8", "replace").strip()
           or "\n".join(tail[-8:])
           or f"rclone rcat exited {rc.returncode}")
    print(f"[Stream] {job_id} FAILED to stream to {remote_path}:\n{err}")
    report.fail(job_id, err[:500])


def download_stream(job_id, url, headers=None, format_id=None, proxy=None,
                    report=None, sink="local", rcat_remote=None, title=None):
    """Run yt-dlp with progress tracking; manages the job status end to end."""
    report = report or _Reporter()
    to_remote = sink == "rcat" and bool(rcat_remote)
    if not to_remote:
        os.makedirs(STREAMS_DIR, exist_ok=True)
    report.update(job_id, status="running", progress=0)

    prefix = f"pzstream_{job_id}_"
    outtmpl = os.path.join(STREAMS_DIR, prefix + "%(title).80s [%(id)s].%(ext)s")
    progress_tmpl = (
        "PZPROG:%(progress.downloaded_bytes)s/%(progress.total_bytes)s/"
        "%(progress.total_bytes_estimate)s/%(progress.speed)s/%(progress.eta)s"
    )
    cmd = [
        ytdlp_bin(),
        # "-" writes the media to stdout so rclone can take it on stdin. The
        # progress template then has to leave on stderr, which is why the two
        # streams are read separately in _run_rcat.
        "-o", "-" if to_remote else outtmpl,
        "--no-warnings", "--no-playlist",
        "--newline", "--progress-template", progress_tmpl,
        # Keep partial live recordings valid & recoverable if the stream drops.
        # Doing double duty when piping: mpegts is the container that stays
        # playable while it is still being written.
        "--hls-use-mpegts", "--retries", "15", "--fragment-retries", "15",
    ]
    ff = ffmpeg_location()
    if ff:
        cmd += ["--ffmpeg-location", ff]
    cmd += _proxy_args(proxy)
    cmd += build_ytdlp_header_args(headers)
    if format_id:
        cmd += ["-f", format_id]
    cmd.append(url)

    if to_remote:
        target = _rcat_target(rcat_remote, title, job_id)
        print(f"[Stream] {job_id} streaming to {target}")
        return _run_rcat(cmd, target, report, job_id)

    print(f"[Stream] {job_id} downloading: {url}")
    # New process group on Windows so we can send CTRL_BREAK for a *graceful*
    # stop — yt-dlp then finalizes/muxes the partial live recording into a real
    # file instead of leaving a .part behind.
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, encoding="utf-8", errors="replace",
            creationflags=creationflags,
        )
    except FileNotFoundError:
        report.fail(job_id, "yt-dlp not installed")
        return
    except Exception as e:
        report.fail(job_id, e)
        return

    with PROCESSES_LOCK:
        PROCESSES[job_id] = proc

    tail = []
    try:
        for line in proc.stdout:
            line = line.rstrip("\n")
            if line.startswith("PZPROG:"):
                parts = line[len("PZPROG:"):].split("/")
                if len(parts) == 5:
                    downloaded = _num(parts[0])
                    total = _num(parts[1]) or _num(parts[2])
                    speed = _num(parts[3])
                    eta = _num(parts[4])
                    percent = None
                    if downloaded is not None and total:
                        percent = round(min(100.0, downloaded / total * 100.0), 1)
                    report.update(
                        job_id,
                        progress=percent if percent is not None else 0,
                        downloaded_bytes=int(downloaded) if downloaded else 0,
                        total_bytes=int(total) if total else 0,
                        speed=speed, eta=eta,
                    )
            else:
                tail.append(line)
                if len(tail) > 15:
                    tail.pop(0)
    finally:
        proc.wait()
        with PROCESSES_LOCK:
            PROCESSES.pop(job_id, None)

    was_stopped = job_id in STOPPED
    # Prefer a finalized file; otherwise rescue a leftover .part (dropped
    # connection or hard kill) so we never throw away a recording.
    path = _find_output(prefix) or _salvage_part(prefix)

    # yt-dlp produced nothing and the user did not stop it: try ffmpeg before
    # calling it a failure. See record_with_ffmpeg for why the two disagree.
    if not path and not was_stopped:
        print(f"[Stream] {job_id} yt-dlp produced nothing; retrying with ffmpeg")
        report.update(job_id, status="running", progress=0)
        fallback = os.path.join(STREAMS_DIR, prefix + "capture.ts")
        okay, ff_err = record_with_ffmpeg(
            job_id, url, headers, proxy, report=report, out_path=fallback,
        )
        was_stopped = job_id in STOPPED
        if okay:
            path = fallback
        else:
            tail.append(f"ffmpeg fallback: {ff_err}")

    STOPPED.discard(job_id)

    # A produced file is a success even on non-zero exit — that's the normal
    # outcome of stopping/losing a live recording.
    if path:
        path = _finalize_stream_name(path, job_id)
        if os.environ.get("PYTHON_ZIPPER_STREAM_RCLONE") == "1":
            handoff_to_rclone(path)
            path = _find_output(prefix) or path  # may have moved
        filename = os.path.basename(path)
        report.update(job_id, save_path=os.path.abspath(path), save_dir=STREAMS_DIR)
        report.complete(job_id, archives=[filename], rclone_complete=False)
        print(f"[Stream] {job_id} saved -> {path}")
    elif was_stopped or (proc.returncode is not None and proc.returncode < 0):
        report.update(job_id, status="aborted", progress=0)
        print(f"[Stream] {job_id} stopped with no output")
    else:
        # Show the reason on the server console. yt-dlp does not echo secret
        # headers, so this tail is safe to print.
        err = "\n".join(tail[-8:]) or f"yt-dlp exited {proc.returncode}"
        print(f"[Stream] {job_id} FAILED (exit {proc.returncode}):\n{err}")
        report.fail(job_id, err)


def stop_stream(job_id):
    """Gracefully stop a running download so a partial file is still finalized.

    On Windows this sends CTRL_BREAK to the process group (yt-dlp muxes what it
    has and exits); we wait for that to finish, then hard-kill only if needed.
    """
    with PROCESSES_LOCK:
        proc = PROCESSES.get(job_id)
    if not proc:
        return False
    STOPPED.add(job_id)
    try:
        if os.name == "nt":
            try:
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            except Exception:
                proc.terminate()
        else:
            proc.terminate()
        try:
            proc.wait(timeout=25)  # allow HLS finalize/mux
        except subprocess.TimeoutExpired:
            proc.kill()
    except Exception as e:
        print(f"[Stream] Error stopping {job_id}: {e}")
        return False
    return True
