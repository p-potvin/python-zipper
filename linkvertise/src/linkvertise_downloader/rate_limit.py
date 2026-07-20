from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LiveRunGuard:
    dry_run: bool
    yes_live: bool
    max_links: int | None
    rate: str | None

    def validate(self) -> str:
        if self.dry_run:
            return "dry-run"
        if not self.yes_live or self.max_links is None or not self.rate:
            raise ValueError("live mode requires --yes-live, --max-links, and --rate")
        if self.max_links < 1:
            raise ValueError("live mode requires --max-links >= 1")
        return "live"
