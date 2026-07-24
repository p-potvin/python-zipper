"""
Live-stream download support for the browser extension.

- probe_stream: yt-dlp -j metadata (title, thumbnail, duration, quality formats)
- download_stream: progress-tracked yt-dlp download, killable per job, saved locally
- stop_stream: terminate a running download

Streams are saved to STREAMS_DIR and, unlike the image pipeline, are NOT moved
off to rclone by default (set PYTHON_ZIPPER_STREAM_RCLONE=1 to opt in) so the
file actually persists somewhere the user can open.
"""

import os
import json
import signal
import subprocess
import threading

from ds_helpers import build_ytdlp_header_args, handoff_to_rclone, ytdlp_bin, ffmpeg_location
from ds_jobs import update_job, complete_job, fail_job

STREAMS_DIR = os.environ.get("PYTHON_ZIPPER_STREAMS_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".downloaded", "streams"
)
STREAMS_DIR = os.path.abspath(STREAMS_DIR)

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


def probe_stream(url, headers=None, proxy=None):
    """Return metadata + selectable formats for a stream URL (yt-dlp -j)."""
    cmd = [ytdlp_bin(), "-j", "--no-warnings", "--no-playlist"]
    cmd += _proxy_args(proxy)
    cmd += build_ytdlp_header_args(headers)
    cmd.append(url)
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


def download_stream(job_id, url, headers=None, format_id=None, proxy=None):
    """Run yt-dlp with progress tracking; manages the job status end to end."""
    os.makedirs(STREAMS_DIR, exist_ok=True)
    update_job(job_id, status="running", progress=0)

    prefix = f"pzstream_{job_id}_"
    outtmpl = os.path.join(STREAMS_DIR, prefix + "%(title).80s [%(id)s].%(ext)s")
    progress_tmpl = (
        "PZPROG:%(progress.downloaded_bytes)s/%(progress.total_bytes)s/"
        "%(progress.total_bytes_estimate)s/%(progress.speed)s/%(progress.eta)s"
    )
    cmd = [
        ytdlp_bin(), "-o", outtmpl, "--no-warnings", "--no-playlist",
        "--newline", "--progress-template", progress_tmpl,
        # Keep partial live recordings valid & recoverable if the stream drops.
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
        fail_job(job_id, "yt-dlp not installed")
        return
    except Exception as e:
        fail_job(job_id, e)
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
                    update_job(
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
    STOPPED.discard(job_id)
    # Prefer a finalized file; otherwise rescue a leftover .part (dropped
    # connection or hard kill) so we never throw away a recording.
    path = _find_output(prefix) or _salvage_part(prefix)

    # A produced file is a success even on non-zero exit — that's the normal
    # outcome of stopping/losing a live recording.
    if path:
        if os.environ.get("PYTHON_ZIPPER_STREAM_RCLONE") == "1":
            handoff_to_rclone(path)
            path = _find_output(prefix) or path  # may have moved
        filename = os.path.basename(path)
        update_job(job_id, save_path=os.path.abspath(path), save_dir=STREAMS_DIR)
        complete_job(job_id, archives=[filename], rclone_complete=False)
        print(f"[Stream] {job_id} saved -> {path}")
    elif was_stopped or (proc.returncode is not None and proc.returncode < 0):
        update_job(job_id, status="aborted", progress=0)
        print(f"[Stream] {job_id} stopped with no output")
    else:
        # Show the reason on the server console. yt-dlp does not echo secret
        # headers, so this tail is safe to print.
        err = "\n".join(tail[-8:]) or f"yt-dlp exited {proc.returncode}"
        print(f"[Stream] {job_id} FAILED (exit {proc.returncode}):\n{err}")
        fail_job(job_id, err)


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
