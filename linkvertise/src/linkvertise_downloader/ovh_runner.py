from __future__ import annotations


OVH_HOST = "ubuntu@100.67.25.118"
REMOTE_APP_DIR = "/opt/vw-linkvertise"
REMOTE_DATA_DIR = "/srv/vw-linkvertise"


def describe_remote_paths() -> dict[str, str]:
    return {
        "host": OVH_HOST,
        "app_dir": REMOTE_APP_DIR,
        "data_dir": REMOTE_DATA_DIR,
    }
