"""Shared configuration.

DEST_DIR lived in server.py, but the pipeline and the worker both need it and
neither should import the HTTP server to get at a path. One definition, here.
"""

import os
import shutil

# Where downloads land before rclone moves them on.
#
# Deliberately a real local disk, never the gdrive mount: a mount is a
# destination, not scratch space. Writing straight into it swaps a full-disk
# failure for worse ones — a dropped mount mid-write, latency stalls, and
# half-written files that look complete. Landing locally also keeps the drain
# guard meaningful, since "rclone is behind" is observable in a way "the mount
# is being slow" is not.
#
# On OVH this should point at the mounted 50GB SSD rather than the system disk,
# which is what filled up and froze the box. Set PYTHON_ZIPPER_DEST_DIR there.
DEST_DIR = os.environ.get("PYTHON_ZIPPER_DEST_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".downloaded"
)


def free_bytes(path: str = None) -> int:
    """Free space on the volume holding `path`. 0 if it can't be determined."""
    try:
        target = path or DEST_DIR
        os.makedirs(target, exist_ok=True)
        return shutil.disk_usage(target).free
    except Exception:
        return 0

