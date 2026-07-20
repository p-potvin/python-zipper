from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class DownloadResult:
    path: Path
    bytes_written: int


def reserve_download_path(download_dir: str | Path, filename: str) -> Path:
    target_dir = Path(download_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    safe_name = Path(filename).name
    return target_dir / f"{safe_name}.part"


def choose_filename(url: str, headers) -> str:
    content_disposition = headers.get("Content-Disposition") or headers.get("content-disposition")
    if content_disposition:
        filename_match = None
        for pattern in (
            r"filename\*=UTF-8''([^;]+)",
            r'filename="([^"]+)"',
            r"filename=([^;]+)",
        ):
            filename_match = __import__("re").search(pattern, content_disposition)
            if filename_match:
                break
        if filename_match:
            return Path(unquote(filename_match.group(1).strip())).name

    path_name = Path(unquote(urlparse(url).path)).name
    return path_name or "download.bin"


def download_url(
    url: str,
    download_dir: str | Path,
    *,
    opener=urlopen,
    timeout_seconds: int = 120,
    chunk_size: int = 1024 * 1024,
    max_bytes: int | None = 50 * 1024 * 1024 * 1024,
) -> DownloadResult:
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 VaultWares-Linkvertise/0.1"})
    with opener(request, timeout=timeout_seconds) as response:
        content_type = (response.headers.get("Content-Type") or response.headers.get("content-type") or "").lower()
        if "text/html" in content_type:
            raise RuntimeError(f"Refusing to download HTML response from {url}")
        filename = choose_filename(url, response.headers)
        part_path = reserve_download_path(download_dir, filename)
        final_path = part_path.with_suffix("") if part_path.name.endswith(".part") else part_path
        bytes_written = 0
        try:
            with part_path.open("wb") as handle:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    bytes_written += len(chunk)
                    if max_bytes is not None and bytes_written > max_bytes:
                        raise RuntimeError(
                            f"Download exceeded maximum download size of {max_bytes} bytes"
                        )
                    handle.write(chunk)
        except Exception:
            part_path.unlink(missing_ok=True)
            raise
        os.replace(part_path, final_path)
        return DownloadResult(path=final_path, bytes_written=bytes_written)


class Downloader:
    def __init__(self, timeout_seconds: int = 120, max_bytes: int | None = 50 * 1024 * 1024 * 1024):
        self.timeout_seconds = timeout_seconds
        self.max_bytes = max_bytes

    def download(self, url: str, download_dir: str | Path) -> DownloadResult:
        return download_url(
            url,
            download_dir,
            timeout_seconds=self.timeout_seconds,
            max_bytes=self.max_bytes,
        )
