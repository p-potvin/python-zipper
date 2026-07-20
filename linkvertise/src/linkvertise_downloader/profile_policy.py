from __future__ import annotations

from pathlib import Path


ALLOWED_PROFILE_STEMS = {
    "ca-mtr-wg-004",
    "ca-mtr-wg-201",
    "ca-mtr-wg-202",
    "ca-mtr-wg-301",
    "ca-mtr-wg-302",
    "ca-mtr-wg-303",
    "ca-mtr-wg-304",
    "ca-mtr-wg-305",
    "ca-mtr-wg-306",
    "ca-mtr-wg-307",
    "ca-mtr-wg-308",
    "ca-tor-wg-001",
    "ca-tor-wg-002",
    "ca-tor-wg-201",
    "ca-tor-wg-202",
    "ca-tor-wg-203",
    "ca-tor-wg-204",
    "ca-tor-wg-205",
    "ca-tor-wg-206",
    "ca-tor-wg-207",
    "ca-van-wg-201",
    "ca-van-wg-202",
    "ca-van-wg-301",
    "ca-van-wg-302",
    "ca-yyc-wg-201",
    "ca-yyc-wg-202",
}


def normalize_profile_stem(profile: str | Path) -> str:
    name = Path(profile).name
    return name[:-5] if name.endswith(".conf") else name


def is_allowed_profile(profile: str | Path) -> bool:
    return normalize_profile_stem(profile) in ALLOWED_PROFILE_STEMS


def filter_allowed_profiles(source_dir: str | Path) -> list[Path]:
    source = Path(source_dir)
    return sorted(
        (path for path in source.glob("*.conf") if is_allowed_profile(path)),
        key=lambda path: path.name,
    )


def require_allowed_profile(profile: str | Path) -> str:
    stem = normalize_profile_stem(profile)
    if stem not in ALLOWED_PROFILE_STEMS:
        raise ValueError(f"profile is outside the allowed Mullvad window: {stem}")
    return stem
