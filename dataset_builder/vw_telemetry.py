"""Model-run telemetry bridge for the dataset-builder vision models.

Records one run per model invocation through ``vaultwares_adk.telemetry``, so
DETR detection and the local upscaler sit in the same series as the ASR,
HuggingFace, Ollama and ComfyUI work rather than being invisible.

Two rules, same as the media bridge in vault-explorer:

* **Lazy.** The recorder is stdlib-only, but it is resolved on first use and
  cached so a script that never touches a model pays nothing for importing this.
* **Never break the caller.** Every function swallows its own errors. An image
  must not fail to upscale because telemetry could not be written.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Optional

_adk: Any = None
_state = "unloaded"  # unloaded | ready | unavailable


def _load() -> bool:
    global _adk, _state
    if _state != "unloaded":
        return _state == "ready"

    here = Path(__file__).resolve()
    candidates = [os.environ.get("VW_ADK_PATH")]
    for parent in list(here.parents)[:4]:
        candidates.append(str(parent / "vaultwares-adk"))
    for candidate in candidates:
        if candidate and Path(candidate).is_dir() and candidate not in sys.path:
            sys.path.insert(0, candidate)

    try:
        from vaultwares_adk import telemetry  # type: ignore

        _adk = telemetry
        _state = "ready"
    except Exception:
        _adk = None
        _state = "unavailable"
    return _state == "ready"


def available() -> bool:
    return _load()


def run(
    *,
    model: str,
    task: str,
    provider: str = "local",
    runtime: str = "torch",
    project: Optional[str] = None,
    service: Optional[str] = None,
    **fields: Any,
):
    """Context manager for one model invocation.

    Returns a no-op stand-in when the recorder is unavailable, so call sites
    read identically either way.
    """
    if not _load():
        return _NullRun()
    try:
        return _adk.ModelRun(
            provider=provider,
            runtime=runtime,
            model=model,
            task=task,
            project=project or os.environ.get("VW_PROJECT") or "python-zipper",
            service=service,
            # Local weights on our own GPU: a real zero, not an unknown.
            cost_usd=0.0,
            priced_exactly=True,
            is_free=True,
            **fields,
        )
    except Exception:
        return _NullRun()


def record(**fields: Any):
    """One-shot record for work that was already timed, or never ran."""
    if not _load():
        return None
    try:
        fields.setdefault("project", os.environ.get("VW_PROJECT") or "python-zipper")
        fields.setdefault("cost_usd", 0.0)
        fields.setdefault("is_free", True)
        return _adk.record_run(**fields)
    except Exception:
        return None


def flush(timeout: float = 10.0) -> None:
    """Ship queued runs. These scripts are short-lived, so a run recorded and
    never flushed dies with the process."""
    if not _load():
        return
    try:
        _adk.shutdown(timeout=timeout)
    except Exception:
        pass


class _NullRun:
    record = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __getattr__(self, _name):
        def _noop(*_args, **_kwargs):
            return self

        return _noop
