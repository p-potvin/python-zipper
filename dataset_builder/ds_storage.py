"""Where files end up, and how much room is left.

A completed job used to report a filename and a boolean: `rclone_complete`.
That answers almost none of the questions actually asked of it — *which* remote
took it, whether the local copy is still there, whether the next job will even
fit. The extension could only offer "reveal in explorer", which is wrong twice
over: the file may be on a different machine entirely, and if rclone moved it
there is nothing local left to reveal.

So this module reports the three things that matter after a download:

  - the landing directory and how full its volume is,
  - the configured remotes in priority order, and whether rclone can see them,
  - for each remote, what the provider says about its own free space.

`rclone about` is a network round trip per remote, so it is cached. A drive's
free space does not change fast enough to be worth asking twice in a minute,
and the panel polls.
"""

import json
import os
import subprocess
import threading
import time

from ds_config import DEST_DIR

# Priority is persisted rather than held in the environment so that reordering
# remotes from the extension survives a service restart. The env var stays as
# the default and as the escape hatch for a machine that is configured by
# deployment rather than by hand.
CONFIG_PATH = os.environ.get("PYTHON_ZIPPER_RCLONE_CONFIG") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".zipper-rclone.json"
)

DEFAULT_RCLONE_REMOTES = "gdrive:python-zipper,proton:python-zipper"

_ABOUT_CACHE = {}
_ABOUT_TTL = 60.0
_LOCK = threading.Lock()


# ---- configuration ----------------------------------------------------------

def _env_remotes():
    raw = os.environ.get("PYTHON_ZIPPER_RCLONE_REMOTES", DEFAULT_RCLONE_REMOTES)
    return [r.strip() for r in raw.split(",") if r.strip()]


def load_config():
    """Stored config, falling back to the environment.

    A malformed or unreadable file falls back rather than raising: this is read
    on the hot path of every handoff, and a bad config file must not be able to
    stop downloads from being filed.
    """
    cfg = {"remotes": _env_remotes(), "enabled": True}
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        if isinstance(stored, dict):
            remotes = stored.get("remotes")
            if isinstance(remotes, list):
                clean = [str(r).strip() for r in remotes if str(r).strip()]
                if clean:
                    cfg["remotes"] = clean
            if "enabled" in stored:
                cfg["enabled"] = bool(stored.get("enabled"))
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"[Server] Ignoring unreadable rclone config at {CONFIG_PATH}: {e}")
    return cfg


def save_config(remotes=None, enabled=None):
    """Write the config back, merging with what is already there."""
    cfg = load_config()
    if remotes is not None:
        clean = [str(r).strip() for r in remotes if str(r).strip()]
        # An empty list would silently disable the handoff while still
        # reporting it as enabled. Refuse it rather than store it.
        if clean:
            cfg["remotes"] = clean
    if enabled is not None:
        cfg["enabled"] = bool(enabled)
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
    except Exception as e:
        print(f"[Server] Could not persist rclone config: {e}")
    return cfg


def configured_remotes():
    """Remotes in the order they should be tried."""
    return load_config()["remotes"]


def rclone_enabled_by_config():
    return load_config()["enabled"]


# ---- rclone -----------------------------------------------------------------

def _run_rclone(args, timeout=20):
    try:
        return subprocess.run(
            ["rclone"] + args, capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError:
        return None
    except Exception as e:
        print(f"[Server] rclone {' '.join(args)} failed: {e}")
        return None


def rclone_available():
    r = _run_rclone(["version"], timeout=10)
    return bool(r and r.returncode == 0)


def known_remotes():
    """Remote names rclone itself knows about, so a typo is visible as one."""
    r = _run_rclone(["listremotes"], timeout=10)
    if not r or r.returncode != 0:
        return []
    return [line.strip().rstrip(":") for line in r.stdout.splitlines() if line.strip()]


def _remote_root(remote):
    """`gdrive:python-zipper` -> `gdrive:` — `about` takes the remote, not a path."""
    return remote.split(":", 1)[0] + ":" if ":" in remote else remote + ":"


def remote_about(remote, force=False):
    """Provider-reported space for one remote, cached.

    Returns None where the provider does not implement `about` at all — several
    do not, and that is a fact about the backend rather than an error worth
    surfacing as one.
    """
    key = _remote_root(remote)
    now = time.time()
    with _LOCK:
        hit = _ABOUT_CACHE.get(key)
        if hit and not force and now - hit[0] < _ABOUT_TTL:
            return hit[1]

    r = _run_rclone(["about", key, "--json"], timeout=25)
    data = None
    if r and r.returncode == 0:
        try:
            parsed = json.loads(r.stdout or "{}")
            data = {
                "total": parsed.get("total"),
                "used": parsed.get("used"),
                "free": parsed.get("free"),
                "trashed": parsed.get("trashed"),
            }
        except Exception:
            data = None

    with _LOCK:
        _ABOUT_CACHE[key] = (now, data)
    return data


# ---- report -----------------------------------------------------------------

def _dir_bytes(path, cap=20000):
    """Bytes currently sitting in the landing directory.

    Capped at `cap` entries: this is a staging area, and if something has gone
    wrong enough that it holds twenty thousand files, walking all of them to
    build a status panel would make the problem worse.
    """
    total = 0
    count = 0
    try:
        for entry in os.scandir(path):
            if count >= cap:
                break
            count += 1
            try:
                if entry.is_file():
                    total += entry.stat().st_size
            except OSError:
                continue
    except FileNotFoundError:
        return 0, 0
    except Exception:
        return 0, 0
    return total, count


def storage_report():
    """Everything the panel needs to answer 'where did it go, and is there room'."""
    import shutil

    dest = os.path.abspath(DEST_DIR)
    disk = {"path": dest, "total": 0, "used": 0, "free": 0}
    try:
        os.makedirs(dest, exist_ok=True)
        usage = shutil.disk_usage(dest)
        disk = {"path": dest, "total": usage.total, "used": usage.used, "free": usage.free}
    except Exception as e:
        disk["error"] = str(e)

    staged_bytes, staged_files = _dir_bytes(dest)
    cfg = load_config()
    have_rclone = rclone_available()
    known = set(known_remotes()) if have_rclone else set()

    remotes = []
    for i, remote in enumerate(cfg["remotes"]):
        name = remote.split(":", 1)[0]
        entry = {
            "remote": remote,
            "name": name,
            "priority": i,
            # A remote in the config that rclone has never heard of is the
            # single most common way this is misconfigured, and it is invisible
            # until a download quietly stays local.
            "configured": (name in known) if have_rclone else None,
            "about": None,
        }
        if have_rclone and name in known:
            entry["about"] = remote_about(remote)
        remotes.append(entry)

    return {
        "disk": disk,
        "staged": {"bytes": staged_bytes, "files": staged_files},
        "rclone": {
            "available": have_rclone,
            "enabled": cfg["enabled"],
            "remotes": remotes,
            "known": sorted(known),
            "config_path": os.path.abspath(CONFIG_PATH),
        },
    }
