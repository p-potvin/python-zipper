from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RuntimePaths:
    root: Path = Path("/srv/vw-linkvertise")
    input_dir: Path = Path("/srv/vw-linkvertise/input")
    downloads_dir: Path = Path("/srv/vw-linkvertise/downloads")
    state_dir: Path = Path("/srv/vw-linkvertise/state")
    logs_dir: Path = Path("/srv/vw-linkvertise/logs")
    artifacts_dir: Path = Path("/srv/vw-linkvertise/artifacts")
