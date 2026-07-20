from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .downloader import Downloader
from .resolver import BrowserResolver, ResolutionResult
from .state import SessionStore


@dataclass
class PipelineRunner:
    store: SessionStore
    resolver: BrowserResolver
    downloader: Downloader
    download_dir: Path
    session_dir: Path
    artifacts_dir: Path

    def process_due(
        self,
        now: datetime | None = None,
        max_links: int = 1,
        only_profile: str | None = None,
    ) -> int:
        current_time = now or datetime.now(timezone.utc)
        due = self.store.due_scheduled(current_time) + self.store.due_for_resume(current_time)
        if only_profile:
            due = [record for record in due if record.get("profile_stem") == only_profile]
        processed = 0

        for record in due:
            if processed >= max_links:
                break
            link_id = record["link_id"]
            try:
                result = self.resolver.resolve(
                    url=record["url"],
                    link_id=link_id,
                    profile_stem=record["profile_stem"],
                    session_dir=self.session_dir,
                    artifacts_dir=self.artifacts_dir,
                    now=current_time,
                )
                self._handle_resolution(record, result, current_time)
            except Exception as exc:
                self.store.mark_failed(link_id, str(exc))
            processed += 1

        return processed

    def _handle_resolution(self, record: dict, result: ResolutionResult, now: datetime) -> None:
        link_id = record["link_id"]
        if result.status == "wait":
            self.store.mark_linkvertise_wait(
                link_id=link_id,
                url=record["url"],
                profile_stem=record["profile_stem"],
                session_state_path=str(self.session_dir / record["profile_stem"] / link_id / "storage_state.json"),
                observed_at=now,
            )
            return

        if result.status != "resolved":
            self.store.mark_failed(link_id, f"resolution status: {result.status} {result.detail}".strip())
            return

        link_download_dir = self.download_dir / link_id
        try:
            download_result = self.downloader.download(result.url, link_download_dir)
        except Exception as exc:
            self.store.mark_failed(link_id, f"download failed for {result.url}: {exc}")
            return
        self.store.mark_done(link_id, record["url"], f"{link_id}/{download_result.path.name}")
