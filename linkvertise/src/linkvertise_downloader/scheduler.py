from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha256
from typing import Iterable

from .input_file import LinkItem
from .profile_policy import require_allowed_profile


@dataclass(frozen=True)
class ScheduledLink:
    link_id: str
    url: str
    wave: str
    profile_stem: str
    scheduled_at: datetime
    attempt: int = 0


def _deterministic_offset_minutes(seed: str, low: int, high: int) -> int:
    span = high - low
    digest = sha256(seed.encode("utf-8")).hexdigest()
    return low + (int(digest[:8], 16) % (span + 1))


def build_two_wave_schedule(
    links: Iterable[LinkItem],
    batch_start: datetime,
    wave_a_profile: str,
    wave_b_profile: str,
) -> list[ScheduledLink]:
    profile_a = require_allowed_profile(wave_a_profile)
    profile_b = require_allowed_profile(wave_b_profile)
    if profile_a == profile_b:
        raise ValueError("Wave A and Wave B profiles must be distinct")

    items = list(links)
    split_index = (len(items) + 1) // 2
    scheduled: list[ScheduledLink] = []

    for index, item in enumerate(items):
        if index < split_index:
            wave = "A"
            profile = profile_a
            offset = _deterministic_offset_minutes(f"A:{item.link_id}", 0, 9)
        else:
            wave = "B"
            profile = profile_b
            offset = _deterministic_offset_minutes(f"B:{item.link_id}", 9, 22)

        scheduled.append(
            ScheduledLink(
                link_id=item.link_id,
                url=item.url,
                wave=wave,
                profile_stem=profile,
                scheduled_at=batch_start + timedelta(minutes=offset),
            )
        )

    return scheduled


def next_run_after(now: datetime, seed: str) -> datetime:
    offset = _deterministic_offset_minutes(f"run:{seed}:{now.date().isoformat()}", 50, 70)
    return now + timedelta(minutes=offset)
