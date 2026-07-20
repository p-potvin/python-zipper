from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from .flaresolverr_client import DEFAULT_ENDPOINT, FlaresolverrClient
from .input_file import load_links
from .profile_policy import filter_allowed_profiles, require_allowed_profile
from .rate_limit import LiveRunGuard
from .downloader import Downloader
from .resolver import BrowserResolver, FallbackResolver, FlaresolverrResolver
from .runner import PipelineRunner
from .scheduler import build_two_wave_schedule, next_run_after
from .state import SessionStore


def _add_run_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--input", default="linkvertise/input/links.example.txt")
    parser.add_argument("--state", default="linkvertise/state/session_state.json")
    parser.add_argument("--download-dir", default="linkvertise/downloads")
    parser.add_argument("--max-links", type=int)
    parser.add_argument("--rate")
    parser.add_argument("--yes-live", action="store_true")
    parser.add_argument("--dry-run", action="store_true", default=False)
    parser.add_argument("--wave-a-profile", default="ca-mtr-wg-004")
    parser.add_argument("--wave-b-profile", default="ca-yyc-wg-202")
    parser.add_argument("--enable-flaresolverr", action="store_true")
    parser.add_argument("--flaresolverr-endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--flaresolverr-cap", type=int, default=0)
    parser.add_argument("--seed", default="linkvertise")
    parser.add_argument("--persist-schedule", action="store_true")
    parser.add_argument("--run-due", action="store_true")
    parser.add_argument("--only-profile")
    parser.add_argument("--session-dir", default="linkvertise/sessions")
    parser.add_argument("--artifacts-dir", default="linkvertise/artifacts")
    parser.add_argument("--headful", action="store_true")
    parser.add_argument("--resolver-timeout-ms", type=int, default=60000)
    parser.add_argument("--download-timeout-seconds", type=int, default=120)
    parser.add_argument("--max-download-bytes", type=int, default=50 * 1024 * 1024 * 1024)


def _profiles(args: argparse.Namespace) -> int:
    profiles = filter_allowed_profiles(args.source)
    for profile in profiles:
        print(profile.name)
    return 0


def _run(args: argparse.Namespace) -> int:
    dry_run = args.dry_run or not args.yes_live
    mode = LiveRunGuard(
        dry_run=dry_run,
        yes_live=args.yes_live,
        max_links=args.max_links,
        rate=args.rate,
    ).validate()

    profile_a = require_allowed_profile(args.wave_a_profile)
    profile_b = require_allowed_profile(args.wave_b_profile)
    links = load_links(args.input)
    if args.max_links is not None:
        links = links[: args.max_links]

    schedule = build_two_wave_schedule(
        links,
        batch_start=datetime.now(timezone.utc),
        wave_a_profile=profile_a,
        wave_b_profile=profile_b,
    )

    if args.persist_schedule:
        store = SessionStore(args.state)
        for item in schedule:
            store.mark_scheduled_if_new(
                link_id=item.link_id,
                url=item.url,
                wave=item.wave,
                profile_stem=item.profile_stem,
                scheduled_at=item.scheduled_at,
                attempt=item.attempt,
            )

    flaresolverr = FlaresolverrClient(
        endpoint=args.flaresolverr_endpoint,
        enabled=args.enable_flaresolverr,
        request_cap=args.flaresolverr_cap,
    )
    if args.enable_flaresolverr and args.flaresolverr_cap < 1:
        raise ValueError("--enable-flaresolverr requires --flaresolverr-cap >= 1")

    processed = 0
    if args.run_due:
        if mode != "live":
            raise ValueError("--run-due requires live mode with --yes-live, --max-links, and --rate")
        primary = BrowserResolver(headless=not args.headful, timeout_ms=args.resolver_timeout_ms)
        fallback = FlaresolverrResolver(flaresolverr) if args.enable_flaresolverr else None
        runner = PipelineRunner(
            store=SessionStore(args.state),
            resolver=FallbackResolver(primary, fallback),
            downloader=Downloader(
                timeout_seconds=args.download_timeout_seconds,
                max_bytes=args.max_download_bytes,
            ),
            download_dir=Path(args.download_dir),
            session_dir=Path(args.session_dir),
            artifacts_dir=Path(args.artifacts_dir),
        )
        processed = runner.process_due(max_links=args.max_links, only_profile=args.only_profile)

    payload = {
        "mode": mode,
        "download_dir": str(Path(args.download_dir)),
        "state": str(Path(args.state)),
        "schedule_persisted": bool(args.persist_schedule),
        "due_processed": processed,
        "only_profile": args.only_profile,
        "link_count": len(links),
        "next_run_at": next_run_after(datetime.now(timezone.utc), args.seed).isoformat(),
        "flaresolverr": {
            "enabled": flaresolverr.enabled,
            "endpoint": flaresolverr.endpoint,
            "request_cap": flaresolverr.request_cap,
        },
        "schedule": [
            {
                "link_id": item.link_id,
                "wave": item.wave,
                "profile_stem": item.profile_stem,
                "scheduled_at": item.scheduled_at.isoformat(),
            }
            for item in schedule
        ],
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="File-driven Linkvertise downloader scaffold")
    subparsers = parser.add_subparsers(dest="command")

    profiles = subparsers.add_parser("profiles", help="List allowed Mullvad profile filenames")
    profiles.add_argument("--source", required=True)
    profiles.add_argument("--dry-run", action="store_true", default=True)
    profiles.set_defaults(func=_profiles)

    _add_run_args(parser)
    parser.set_defaults(func=_run)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
