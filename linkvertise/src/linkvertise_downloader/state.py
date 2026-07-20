from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


class SessionStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.records: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.records = {item["link_id"]: item for item in data.get("records", [])}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"records": sorted(self.records.values(), key=lambda item: item["link_id"])}
        self.path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    def get(self, link_id: str) -> dict[str, Any]:
        return self.records[link_id]

    def upsert(self, record: dict[str, Any]) -> None:
        self.records[record["link_id"]] = record
        self._save()

    def mark_linkvertise_wait(
        self,
        link_id: str,
        url: str,
        profile_stem: str,
        session_state_path: str,
        observed_at: datetime,
    ) -> None:
        self.upsert(
            {
                "link_id": link_id,
                "url": url,
                "status": "idle_until_resume",
                "profile_stem": profile_stem,
                "session_state_path": session_state_path,
                "observed_at": observed_at.isoformat(),
                "resume_at": (observed_at + timedelta(hours=1)).isoformat(),
            }
        )

    def mark_done(self, link_id: str, url: str, output_name: str) -> None:
        record = dict(self.records.get(link_id, {"link_id": link_id, "url": url}))
        record["url"] = url
        record["status"] = "done"
        record["output_name"] = output_name
        record.pop("error", None)
        self.upsert(record)

    def mark_scheduled(
        self,
        link_id: str,
        url: str,
        wave: str,
        profile_stem: str,
        scheduled_at: datetime,
        attempt: int = 0,
    ) -> None:
        self.upsert(
            {
                "link_id": link_id,
                "url": url,
                "status": "scheduled",
                "wave": wave,
                "profile_stem": profile_stem,
                "scheduled_at": scheduled_at.isoformat(),
                "attempt": attempt,
            }
        )

    def mark_scheduled_if_new(
        self,
        link_id: str,
        url: str,
        wave: str,
        profile_stem: str,
        scheduled_at: datetime,
        attempt: int = 0,
    ) -> bool:
        if link_id in self.records:
            return False
        self.mark_scheduled(link_id, url, wave, profile_stem, scheduled_at, attempt)
        return True

    def is_done(self, link_id: str) -> bool:
        return self.records.get(link_id, {}).get("status") == "done"

    def due_for_resume(self, now: datetime) -> list[dict[str, Any]]:
        due: list[dict[str, Any]] = []
        for record in self.records.values():
            if record.get("status") != "idle_until_resume":
                continue
            resume_at = datetime.fromisoformat(record["resume_at"])
            if resume_at <= now:
                due.append(record)
        return sorted(due, key=lambda item: item["resume_at"])

    def due_scheduled(self, now: datetime) -> list[dict[str, Any]]:
        due: list[dict[str, Any]] = []
        for record in self.records.values():
            if record.get("status") not in {"scheduled", "ready_to_click_download"}:
                continue
            scheduled_at = datetime.fromisoformat(record["scheduled_at"])
            if scheduled_at <= now:
                due.append(record)
        return sorted(due, key=lambda item: item["scheduled_at"])

    def mark_failed(self, link_id: str, error: str) -> None:
        record = dict(self.records.get(link_id, {"link_id": link_id}))
        record["status"] = "failed"
        record["error"] = error
        self.upsert(record)
