from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlparse


ALLOWED_HOST_PARTS = (
    "linkvertise.com",
    "link-to.net",
    "direct-link.net",
    "link-center.net",
    "link-hub.net",
    "link-target.net",
)


@dataclass(frozen=True)
class LinkItem:
    link_id: str
    url: str
    source_line: int


def _normalize_url(raw: str) -> str:
    url = raw.strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"unsupported URL scheme on line: {raw}")
    host = parsed.netloc.lower()
    if not any(host == part or host.endswith(f".{part}") for part in ALLOWED_HOST_PARTS):
        raise ValueError(f"unsupported link host: {host}")
    return url


def _link_id(url: str) -> str:
    return sha256(url.encode("utf-8")).hexdigest()[:16]


def load_links(path: str | Path) -> list[LinkItem]:
    source = Path(path)
    seen: set[str] = set()
    links: list[LinkItem] = []

    for line_no, raw_line in enumerate(source.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        url = _normalize_url(line)
        if url in seen:
            continue
        seen.add(url)
        links.append(LinkItem(link_id=_link_id(url), url=url, source_line=line_no))

    return links
