from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
import re
from pathlib import Path
from urllib.parse import urlparse


@dataclass(frozen=True)
class ResolutionResult:
    status: str
    url: str
    detail: str = ""
    wait_for: timedelta | None = None
    filename: str | None = None


class ResolverNotImplemented(RuntimeError):
    pass


SHORTENER_HOST_PARTS = (
    "linkvertise.com",
    "link-target.net",
    "link-to.net",
    "direct-link.net",
    "link-center.net",
    "link-hub.net",
)

IGNORED_CANDIDATE_HOST_PARTS = (
    "antiblock.org",
    "bizseasky.com",
    "chargebee.com",
    "cloudflare.com",
    "cloudflareinsights.com",
    "fonts.gstatic.com",
    "fonts.googleapis.com",
    "google-analytics.com",
    "googletagmanager.com",
    "gstatic.com",
    "imagedelivery.net",
    "w3.org",
)

BLOCKED_INTERSTITIAL_HOST_PARTS = (
    "antiblock.org",
)

IGNORED_CANDIDATE_SUFFIXES = (
    ".css",
    ".js",
    ".mjs",
    ".svg",
    ".ico",
    ".webp",
    ".woff",
    ".woff2",
    ".ttf",
)

CLICK_TEXTS = (
    "free access",
    "continue",
    "get link",
    "download",
    "open",
    "next",
    "proceed",
)


def _is_shortener_url(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return any(host == part or host.endswith(f".{part}") for part in SHORTENER_HOST_PARTS)


def _is_ignored_candidate_url(url: str) -> bool:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    if any(host == part or host.endswith(f".{part}") for part in IGNORED_CANDIDATE_HOST_PARTS):
        return True
    return path.endswith(IGNORED_CANDIDATE_SUFFIXES)


def extract_candidate_urls(content: str) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()
    for match in re.findall(r"https?://[^\s'\"<>]+", content):
        url = match.rstrip("),.;]")
        if _is_shortener_url(url):
            continue
        if _is_ignored_candidate_url(url):
            continue
        if url not in seen:
            seen.add(url)
            candidates.append(url)
    return candidates


def _detect_wait(text: str) -> timedelta | None:
    lowered = text.lower()
    if re.search(r"\b1\s*(hour|hr|h)\b", lowered):
        return timedelta(hours=1)
    minutes = re.search(r"\b(60)\s*(minutes|min|m)\b", lowered)
    if minutes:
        return timedelta(minutes=int(minutes.group(1)))
    return None


def classify_page_snapshot(url: str, text: str, html: str) -> ResolutionResult:
    host = urlparse(url).netloc.lower()
    if any(host == part or host.endswith(f".{part}") for part in BLOCKED_INTERSTITIAL_HOST_PARTS):
        return ResolutionResult(status="blocked", url=url, detail="known interstitial host detected")

    combined = f"{text}\n{html}".lower()
    if "5xx error | cloudflare" in combined or "cf-error-details" in combined:
        return ResolutionResult(status="blocked", url=url, detail="Cloudflare error page detected")

    wait_for = _detect_wait(text)
    if wait_for is not None:
        return ResolutionResult(status="wait", url=url, detail="Linkvertise wait state detected", wait_for=wait_for)

    if not _is_shortener_url(url):
        return ResolutionResult(status="resolved", url=url, detail="browser navigated to external URL")

    candidates = extract_candidate_urls(f"{html}\n{text}")
    if candidates:
        return ResolutionResult(status="resolved", url=candidates[0], detail="external URL discovered")

    return ResolutionResult(status="blocked", url=url, detail="no external URL found")


class BrowserResolver:
    def __init__(self, headless: bool = True, timeout_ms: int = 60000, max_clicks: int = 8):
        self.headless = headless
        self.timeout_ms = timeout_ms
        self.max_clicks = max_clicks

    def resolve(
        self,
        *,
        url: str,
        link_id: str,
        profile_stem: str,
        session_dir: str | Path,
        artifacts_dir: str | Path,
        now,
    ) -> ResolutionResult:
        try:
            from patchright.sync_api import TimeoutError as PlaywrightTimeoutError
            from patchright.sync_api import sync_playwright
        except ImportError as exc:
            raise ResolverNotImplemented(
                "Patchright is required for live Linkvertise resolution. "
                "Install the browser extra and run `patchright install chromium`."
            ) from exc

        user_data_dir = Path(session_dir) / profile_stem / link_id
        user_data_dir.mkdir(parents=True, exist_ok=True)
        artifact_dir = Path(artifacts_dir)
        artifact_dir.mkdir(parents=True, exist_ok=True)
        
        import sys
        sys.path.append(str(Path(__file__).resolve().parent.parent.parent.parent))
        try:
            import proxy_utils
            proxy_config = proxy_utils.get_patchright_proxy()
        except ImportError:
            proxy_config = None

        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                channel="chrome",                 # Uses your stable Google Chrome app binary
                headless=False,                  # OPENS THE BROWSER VISUALLY
                no_viewport=True,
                user_data_dir=str(user_data_dir),
                executable_path=r"C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.exe",
                artifacts_dir=r"G:\artifacts",
                proxy=proxy_config
            )
            page = context.pages[0] if context.pages else context.new_page()
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=self.timeout_ms)
                for _ in range(self.max_clicks + 1):
                    result = self._classify_page(page)
                    if result.status in {"resolved", "wait"}:
                        context.storage_state(path=str(user_data_dir / "storage_state.json"))
                        return result

                    next_page = self._click_next(context, page)
                    if next_page is None:
                        break
                    page = next_page
                    page.wait_for_timeout(1500)
                html = page.content()
                (artifact_dir / f"{link_id}.html").write_text(html, encoding="utf-8")
                return classify_page_snapshot(page.url, page.locator("body").inner_text(timeout=5000), html)
            except PlaywrightTimeoutError:
                html = page.content()
                (artifact_dir / f"{link_id}.timeout.html").write_text(html, encoding="utf-8")
                return ResolutionResult(status="blocked", url=page.url, detail="browser timeout")
            finally:
                context.close()

    def _classify_page(self, page) -> ResolutionResult:
        text = page.locator("body").inner_text(timeout=5000)
        return classify_page_snapshot(page.url, text, page.content())

    def _click_next(self, context, page):
        for text in CLICK_TEXTS:
            locator = page.get_by_text(re.compile(text, re.IGNORECASE)).first
            try:
                if locator.is_visible(timeout=1000):
                    before_pages = list(context.pages)
                    try:
                        with context.expect_page(timeout=5000) as new_page_info:
                            locator.click(timeout=5000)
                        new_page = new_page_info.value
                        new_page.wait_for_load_state("domcontentloaded", timeout=self.timeout_ms)
                        new_page.bring_to_front()
                        if page != new_page:
                            try:
                                page.close()
                            except Exception:
                                pass
                        return new_page
                    except Exception:
                        after_pages = list(context.pages)
                        if len(after_pages) > len(before_pages):
                            new_page = after_pages[-1]
                            try:
                                new_page.wait_for_load_state("domcontentloaded", timeout=self.timeout_ms)
                                new_page.bring_to_front()
                            except Exception:
                                pass
                            if page != new_page:
                                try:
                                    page.close()
                                except Exception:
                                    pass
                            return new_page
                        return page
            except Exception:
                continue
        return None


def resolve_link(url: str, **kwargs) -> ResolutionResult:
    return BrowserResolver().resolve(url=url, **kwargs)


class FlaresolverrResolver:
    def __init__(self, client):
        self.client = client

    def resolve(
        self,
        *,
        url: str,
        link_id: str,
        profile_stem: str,
        session_dir: str | Path,
        artifacts_dir: str | Path,
        now,
    ) -> ResolutionResult:
        solution = self.client.solve_url(url).get("solution", {})
        solution_url = solution.get("url") or url
        html = solution.get("response") or ""
        return classify_page_snapshot(solution_url, "", html)


class FallbackResolver:
    def __init__(self, primary, fallback=None):
        self.primary = primary
        self.fallback = fallback

    def resolve(self, **kwargs) -> ResolutionResult:
        result = self.primary.resolve(**kwargs)
        if result.status == "blocked" and self.fallback is not None:
            return self.fallback.resolve(**kwargs)
        return result
