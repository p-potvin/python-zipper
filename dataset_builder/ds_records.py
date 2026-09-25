"""
The record a recording carries with it: a `<file.ext>.json` sidecar.

Everything known at capture time goes in here, because this is the one moment
it is all in one place. The page, the performer, the stream URL, which client
recorded it and how often it had to resume — an hour later the tab is closed,
the token has expired and the job row has been cleared, and none of it can be
recovered from the file alone.

The shape is the estate's v2 media record (vault-commander
`cli/utils/media_records/`): sectioned by producer, with ffprobe's flat fields
at the root where vault-explorer already reads them. python-zipper writes the
`provenance` and `capture` sections; other tools add theirs later without this
module needing to know about them.

Header *names* are recorded, never their values. They say how the stream had to
be asked for — a Referer, an Authorization — which is worth knowing; the values
are credentials, and a sidecar travels to places a credential should not.
"""

import json
import os
import re
import socket
import subprocess
from datetime import datetime, timezone
from urllib.parse import urlparse, urlunparse

from ds_helpers import ffmpeg_location

SCHEMA = 2
TOOL = "python-zipper"


def sidecar_path(media_path):
    """The canonical sidecar name across the estate: `<file.ext>.json`."""
    return media_path + ".json"


def _iso(ts=None):
    """UTC ISO-8601 — sortable, and unambiguous on whichever machine reads it."""
    dt = datetime.fromtimestamp(ts, timezone.utc) if ts else datetime.now(timezone.utc)
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


def redact_url(url):
    """A stream URL without its query string.

    The query on a live edge is a signed, short-lived token: useless an hour
    later and a credential until then. The path is what identifies the stream
    — the host, the broadcast id, the rendition — and it is kept whole.
    """
    if not url:
        return ""
    try:
        u = urlparse(url)
        return urlunparse((u.scheme, u.netloc, u.path, "", "", ""))
    except Exception:
        return ""


def _ffprobe_bin():
    loc = ffmpeg_location()
    if loc:
        exe = os.path.join(loc, "ffprobe.exe" if os.name == "nt" else "ffprobe")
        if os.path.exists(exe):
            return exe
    return "ffprobe"


def _rate(value):
    """`30000/1001` -> 29.97. ffprobe writes frame rates as fractions."""
    try:
        num, _, den = str(value).partition("/")
        n, d = float(num), float(den or 1)
        return round(n / d, 3) if d else None
    except (TypeError, ValueError):
        return None


def probe_media(path):
    """ffprobe's view of a finished file, in the video family's root keys.

    Returns {} when ffprobe is missing or the file will not open: the sidecar
    is still worth writing without it, and the name just goes without the
    resolution and duration.
    """
    try:
        out = subprocess.run(
            [_ffprobe_bin(), "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", path],
            capture_output=True, timeout=60,
        )
        data = json.loads(out.stdout or b"{}")
    except Exception:
        return {}

    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    info = {
        "hasVideo": video is not None,
        "hasAudio": audio is not None,
    }
    try:
        info["duration"] = round(float(fmt.get("duration")), 3)
    except (TypeError, ValueError):
        pass
    try:
        info["bitrate"] = int(fmt.get("bit_rate"))
    except (TypeError, ValueError):
        pass
    if video:
        info.update({
            "width": video.get("width"),
            "height": video.get("height"),
            "codec": video.get("codec_name"),
            "fps": _rate(video.get("avg_frame_rate") or video.get("r_frame_rate")),
        })
    if audio:
        info.update({
            "audioCodec": audio.get("codec_name"),
            "channels": audio.get("channels"),
        })
        try:
            info["sampleRate"] = int(audio.get("sample_rate"))
        except (TypeError, ValueError):
            pass
    return {k: v for k, v in info.items() if v is not None}


def fmt_duration(seconds):
    """`1h23m`, `12m05s`, `48s` — short enough to sit in a filename."""
    try:
        s = int(round(float(seconds)))
    except (TypeError, ValueError):
        return ""
    if s <= 0:
        return ""
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m"
    if m:
        return f"{m}m{sec:02d}s"
    return f"{sec}s"


def build_record(media_path, job_id, capture, media=None):
    """The v2 record for a recording that has just been finalised.

    `capture` is what the recorder knew; `media` is ffprobe's answer. Flat
    ffprobe fields go at the root, where the video family already keeps them.
    """
    media = media or {}
    try:
        st = os.stat(media_path)
        size, mtime = st.st_size, st.st_mtime
    except OSError:
        size, mtime = None, None

    now = _iso()
    record = {"schema": SCHEMA}
    record.update(media)
    record.update({
        "name": os.path.basename(media_path),
        "size": size,
        "type": "video",
        "vw": {"kind": "video", "created": now, "updated": now},
        "master": {
            "basename": os.path.basename(media_path),
            "ext": os.path.splitext(media_path)[1].lower(),
            "size": size,
            "mtime": _iso(mtime) if mtime else None,
        },
        "fingerprints": {
            "size": size,
            "duration": media.get("duration"),
            "source": "vw",
            "computed": now,
        },
        "provenance": {
            "source_url": redact_url(capture.get("stream_url")),
            "page_url": capture.get("page_url") or "",
            "site": capture.get("site") or "",
            "grabbed_at": capture.get("started_at") or now,
            "job_id": job_id,
            "tool": TOOL,
            "host": socket.gethostname(),
        },
        "capture": {
            "performer": capture.get("performer") or "",
            "username": capture.get("username") or "",
            "tab_title": capture.get("tab_title") or "",
            "label": capture.get("label") or "",
            "stream_url": redact_url(capture.get("stream_url")),
            "audio_url": redact_url(capture.get("audio_url")),
            "original_stream_url": redact_url(capture.get("original_stream_url")),
            "quality": capture.get("quality") or "",
            "format_id": capture.get("format_id") or "",
            "is_live": capture.get("is_live"),
            "recorder": capture.get("recorder") or "",
            "resumes": capture.get("resumes") or 0,
            "sink": capture.get("sink") or "local",
            "proxied": bool(capture.get("proxied")),
            "headers_used": sorted(capture.get("headers_used") or []),
            "thumbnail": capture.get("thumbnail") or "",
            "started_at": capture.get("started_at"),
            "ended_at": capture.get("ended_at"),
            "wall_seconds": capture.get("wall_seconds"),
            "end_reason": capture.get("end_reason") or "",
            "bytes": size,
            "extension_version": capture.get("extension_version") or "",
        },
        "history": [],
    })
    # Empty strings and Nones are noise in a record meant to be read by eye.
    for section in ("provenance", "capture", "master", "fingerprints"):
        record[section] = {
            k: v for k, v in record[section].items() if v not in ("", None)
        }
    return record


def write_sidecar(media_path, record):
    """Atomic write, so a crash mid-write never leaves half a record."""
    target = sidecar_path(media_path)
    tmp = target + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(record, fh, indent=2, ensure_ascii=False)
        os.replace(tmp, target)
        return target
    except Exception as e:
        print(f"[Stream] could not write sidecar for {os.path.basename(media_path)}: {e}")
        try:
            os.remove(tmp)
        except OSError:
            pass
        return None


def read_sidecar(media_path):
    try:
        with open(sidecar_path(media_path), encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


_HOSTILE = re.compile(r'[\\/*?:"<>|\x00-\x1f]')


def clean_basename(name):
    """A user-typed name made safe to write, or "" when nothing is left.

    Only the characters Windows refuses are replaced; everything else is the
    user's choice. A trailing extension they typed is dropped, since the
    recording's own is put back on.
    """
    if not name:
        return ""
    s = _HOSTILE.sub("_", str(name))
    s = re.sub(r"\s+", " ", s).strip().strip(".")
    s = re.sub(r"\.(ts|mp4|mkv|m4v|webm)$", "", s, flags=re.I).strip()
    return s[:180]


def rename_recording(path, new_base, by="user"):
    """Rename a recording and its sidecar together, and log it in the record.

    Returns the new path, or the old one when the name was unusable or the
    rename failed — a recording is never lost over a naming preference.
    """
    base = clean_basename(new_base)
    if not base or not path or not os.path.exists(path):
        return path
    parent = os.path.dirname(path)
    ext = os.path.splitext(path)[1] or ".ts"
    target = os.path.join(parent, base + ext)
    if os.path.abspath(target) == os.path.abspath(path):
        return path
    n = 1
    while os.path.exists(target):
        target = os.path.join(parent, f"{base} ({n}){ext}")
        n += 1
    try:
        os.replace(path, target)
    except Exception as e:
        print(f"[Stream] rename to {os.path.basename(target)} failed ({e}); keeping {path}")
        return path

    record = read_sidecar(path)
    if record is not None:
        record.setdefault("history", []).append({
            "at": _iso(), "event": "rename",
            "from": os.path.basename(path), "to": os.path.basename(target), "by": by,
        })
        record["name"] = os.path.basename(target)
        record.setdefault("master", {})["basename"] = os.path.basename(target)
        record.setdefault("vw", {})["updated"] = _iso()
        if write_sidecar(target, record):
            try:
                os.remove(sidecar_path(path))
            except OSError:
                pass
    print(f"[Stream] renamed by {by} -> {os.path.basename(target)}")
    return target

