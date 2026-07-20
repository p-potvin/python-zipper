"""
Site-specific downloaders — Playwright-based handlers for sites that need custom navigation.

Each handler inherits from BaseSiteHandler and implements:
  - can_handle(url): bool — whether this handler matches the URL
  - download(page, url, download_dir, item_idx) -> str|None — returns local file path or None

Sites supported:
  - balbums.st (converted from bunkr.la/.ru/.to/.is/.cr)
  - cyberfile.me

Cloudflare bypass: falls back to FlareSolverr (localhost:8191) when a CF challenge is detected.
"""

import os
import re
import asyncio
import requests
from urllib.parse import urlparse


FLARESOLVERR_URL = os.environ.get("FLARESOLVERR_URL", "http://localhost:8191")


def is_cloudflare_challenge(page):
    """Check if the page is showing a Cloudflare challenge."""
    try:
        title = page.title()
        if title and ("just a moment" in title.lower() or "cloudflare" in title.lower()):
            return True
        # Check for CF challenge elements
        cf_element = page.query_selector("#challenge-running, .cf-browser-verification, #cf-challenge-running")
        if cf_element:
            return True
        return False
    except Exception:
        return False


def flaresolverr_get(url, retries=2):
    """Use FlareSolverr to bypass Cloudflare and get cookies + user-agent."""
    for attempt in range(retries):
        try:
            resp = requests.post(
                f"{FLARESOLVERR_URL}/v1",
                headers={"Content-Type": "application/json"},
                json={
                    "cmd": "request.get",
                    "url": url,
                    "maxTimeout": 60000,
                },
                timeout=90,
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get("status") == "ok":
                    solution = data.get("solution", {})
                    cookies = solution.get("cookies", [])
                    user_agent = solution.get("userAgent", "")
                    html = solution.get("response", "")
                    return {
                        "cookies": cookies,
                        "user_agent": user_agent,
                        "html": html,
                    }
            print(f"   [FlareSolverr] Attempt {attempt+1} failed: {resp.status_code}")
        except Exception as e:
            print(f"   [FlareSolverr] Attempt {attempt+1} error: {e}")
    return None


def inject_flaresolverr_cookies(page, cookies, user_agent):
    """Inject FlareSolverr cookies into a Playwright page context."""
    if user_agent:
        try:
            page.set_extra_http_headers({"User-Agent": user_agent})
        except Exception:
            pass
    if cookies:
        for cookie in cookies:
            try:
                page.context.add_cookies([{
                    "name": cookie.get("name", ""),
                    "value": cookie.get("value", ""),
                    "domain": cookie.get("domain", ""),
                    "path": cookie.get("path", "/"),
                    "secure": cookie.get("secure", False),
                    "httpOnly": cookie.get("httpOnly", False),
                    "sameSite": "Lax",
                }])
            except Exception:
                pass


# ==============================================================================
# BASE HANDLER
# ==============================================================================

class BaseSiteHandler:
    """Base class for site-specific downloaders."""

    def can_handle(self, url):
        raise NotImplementedError

    async def download(self, page, url, download_dir, item_idx):
        """Navigate to url, trigger download, save to download_dir. Returns local file path or None."""
        raise NotImplementedError

    async def _navigate_with_cf_check(self, page, url, item_idx, timeout=20000):
        """Navigate to URL, falling back to FlareSolverr if Cloudflare blocks us."""
        try:
            await page.goto(url, timeout=timeout)
        except Exception as e:
            print(f"   [{item_idx}] Navigation error (may be CF): {str(e)[:80]}")

        await asyncio.sleep(2)

        if is_cloudflare_challenge(page):
            print(f"   [{item_idx}] Cloudflare challenge detected, using FlareSolverr...")
            cf_result = flaresolverr_get(url)
            if cf_result:
                print(f"   [{item_idx}] FlareSolverr bypassed CF, injecting cookies...")
                inject_flaresolverr_cookies(page, cf_result["cookies"], cf_result["user_agent"])
                try:
                    await page.goto(url, timeout=timeout)
                    await asyncio.sleep(3)
                except Exception:
                    pass
                if is_cloudflare_challenge(page):
                    print(f"   [{item_idx}] [WARN] Still blocked by CF after FlareSolverr")
                    return False
            else:
                print(f"   [{item_idx}] [WARN] FlareSolverr failed to bypass CF")
                return False
        return True


# ==============================================================================
# BALBUMS.ST (bunkr)
# ==============================================================================

class BalbumsHandler(BaseSiteHandler):
    """Handler for balbums.st (bunkr album/media pages)."""

    def can_handle(self, url):
        return "balbums.st" in url.lower() or "bunkr." in url.lower()

    async def download(self, page, url, download_dir, item_idx):
        print(f"   [Balbums] [{item_idx}] Navigating to {url}")

        ok = await self._navigate_with_cf_check(page, url, item_idx)
        if not ok:
            return None

        await asyncio.sleep(3)

        # Strategy: Look for direct download link or download button
        # balbums.st typically has a download button or direct media link

        # 1. Try to find a download button/link
        download_selectors = [
            'a[download]',
            'a[href*="download"]',
            'button:has-text("Download")',
            'a:has-text("Download")',
            'a.btn:has-text("Download")',
            'a[href*=".mp4"]',
            'a[href*=".zip"]',
            'a[href*=".rar"]',
            'a[href*=".7z"]',
            'video source',
            'a[href*="cdn.bunkr"]',
            'a[href*="bunkr."] a[href*="download"]',
        ]

        download_url = None
        for selector in download_selectors:
            try:
                el = page.query_selector(selector)
                if el:
                    href = el.get_attribute("href")
                    if href:
                        download_url = href
                        if not href.startswith("http"):
                            parsed = urlparse(url)
                            download_url = f"{parsed.scheme}://{parsed.netloc}{href}"
                        print(f"   [Balbums] [{item_idx}] Found download link: {download_url}")
                        break
            except Exception:
                continue

        # 2. Try to get direct media URL from page source
        if not download_url:
            try:
                media_url = await page.evaluate("""
                    () => {
                        const video = document.querySelector('video source');
                        if (video) return video.src;
                        const a = document.querySelector('a[download]');
                        if (a) return a.href;
                        const link = document.querySelector('a[href*="cdn.bunkr"]');
                        if (link) return link.href;
                        return null;
                    }
                """)
                if media_url:
                    download_url = media_url
                    print(f"   [Balbums] [{item_idx}] Found media URL from page: {download_url}")
            except Exception:
                pass

        # 3. Try clicking a download button and capturing the download event
        if not download_url:
            print(f"   [Balbums] [{item_idx}] No direct link found, trying button click...")
            for selector in download_selectors:
                try:
                    el = page.query_selector(selector)
                    if el:
                        async with page.expect_download(timeout=15000) as dl_promise:
                            await el.click()
                            try:
                                download = await asyncio.wait_for(dl_promise.value, timeout=15.0)
                                filename = download.suggested_filename
                                output_path = os.path.join(download_dir, filename)
                                await download.save_as(output_path)
                                print(f"   [Balbums] [{item_idx}] [OK] Downloaded: {filename}")
                                return output_path
                            except asyncio.TimeoutError:
                                pass
                        break
                except Exception:
                    continue

        # 4. If we have a direct URL, download it via the browser
        if download_url:
            try:
                async with page.expect_download(timeout=120000) as dl_promise:
                    try:
                        await page.goto(download_url, timeout=15000)
                    except Exception:
                        pass
                    try:
                        download = await asyncio.wait_for(dl_promise.value, timeout=120.0)
                        filename = download.suggested_filename
                        output_path = os.path.join(download_dir, filename)
                        await download.save_as(output_path)
                        file_size = os.path.getsize(output_path)
                        print(f"   [Balbums] [{item_idx}] [OK] Downloaded: {filename} ({file_size / (1024**2):.1f} MB)")
                        return output_path
                    except asyncio.TimeoutError:
                        print(f"   [Balbums] [{item_idx}] [FAIL] Download timed out")
                        return None
            except Exception as e:
                print(f"   [Balbums] [{item_idx}] [FAIL] Download error: {e}")
                return None

        print(f"   [Balbums] [{item_idx}] [FAIL] Could not find download link on page")
        return None


# ==============================================================================
# CYBERFILE.ME
# ==============================================================================

class CyberfileHandler(BaseSiteHandler):
    """Handler for cyberfile.me file hosting."""

    def can_handle(self, url):
        return "cyberfile." in url.lower()

    async def download(self, page, url, download_dir, item_idx):
        print(f"   [Cyberfile] [{item_idx}] Navigating to {url}")

        ok = await self._navigate_with_cf_check(page, url, item_idx)
        if not ok:
            return None

        # cyberfile typically has a download page with a button after a wait timer
        await asyncio.sleep(3)

        # Look for download button (cyberfile uses various patterns)
        download_selectors = [
            'a.btn:has-text("Download")',
            'button:has-text("Download")',
            'a:has-text("Download")',
            'a[href*="download"]',
            'a[download]',
        ]

        for selector in download_selectors:
            try:
                el = page.query_selector(selector)
                if el:
                    print(f"   [Cyberfile] [{item_idx}] Found download button, clicking...")
                    async with page.expect_download(timeout=120000) as dl_promise:
                        await el.click()
                        # Wait for any countdown timer
                        await asyncio.sleep(10)
                        try:
                            download = await asyncio.wait_for(dl_promise.value, timeout=120.0)
                            filename = download.suggested_filename
                            output_path = os.path.join(download_dir, filename)
                            await download.save_as(output_path)
                            print(f"   [Cyberfile] [{item_idx}] [OK] Downloaded: {filename}")
                            return output_path
                        except asyncio.TimeoutError:
                            print(f"   [Cyberfile] [{item_idx}] [FAIL] Download timed out")
                            return None
            except Exception:
                continue

        # Fallback: try to find direct download link in page
        try:
            dl_url = await page.evaluate("""
                () => {
                    let a = document.querySelector('a[href*="download"][href*="cyberfile"]');
                    if (a) return a.href;
                    a = document.querySelector('a[download]');
                    if (a) return a.href;
                    return null;
                }
            """)
            if dl_url:
                print(f"   [Cyberfile] [{item_idx}] Found direct URL: {dl_url}")
                async with page.expect_download(timeout=120000) as dl_promise:
                    try:
                        await page.goto(dl_url, timeout=15000)
                    except Exception:
                        pass
                    download = await asyncio.wait_for(dl_promise.value, timeout=120.0)
                    filename = download.suggested_filename
                    output_path = os.path.join(download_dir, filename)
                    await download.save_as(output_path)
                    return output_path
        except Exception:
            pass

        print(f"   [Cyberfile] [{item_idx}] [FAIL] Could not find download link")
        return None


# ==============================================================================
# STREAMERGIRLS.ORG (via bypass.city)
# ==============================================================================

class StreamergirlsHandler(BaseSiteHandler):
    """Handler for streamergirls.org short links via bypass.city."""

    def can_handle(self, url):
        return "streamergirls." in url.lower()

    async def download(self, page, url, download_dir, item_idx):
        from urllib.parse import quote
        print(f"   [StreamerGirls] [{item_idx}] Resolving via bypass.city: {url}")

        bypass_url = f"https://bypass.city/bypass?bypass={quote(url, safe='')}"
        print(f"   [StreamerGirls] [{item_idx}] Bypass URL: {bypass_url}")

        ok = await self._navigate_with_cf_check(page, bypass_url, item_idx, timeout=30000)
        if not ok:
            return None

        # bypass.city will process the link and show the result
        # Wait for the result to appear
        await asyncio.sleep(5)

        # Try to find the resolved/download URL in the page
        resolved_url = None
        try:
            resolved_url = await page.evaluate(r"""
                () => {
                    // Look for result links
                    let resultLink = document.querySelector('a[href*="download"], a.result-link, a.btn-success');
                    if (resultLink) return resultLink.href;
                    
                    // Look for any link that points to a file/CDN
                    let links = document.querySelectorAll('a');
                    for (let a of links) {
                        let href = a.href || '';
                        if (href.includes('.mp4') || href.includes('.zip') || 
                            href.includes('.rar') || href.includes('.7z') ||
                            href.includes('cdn.') || href.includes('download')) {
                            if (!href.includes('bypass.city') && !href.includes('streamergirls')) {
                                return href;
                            }
                        }
                    }
                    
                    // Check for text area or code block with URL
                    let code = document.querySelector('pre, code, textarea');
                    if (code) {
                        let text = code.textContent || '';
                        let match = text.match(/https?:\/\/[^\s]+/);
                        if (match) return match[0];
                    }
                    
                    return null;
                }
            """)
        except Exception as e:
            print(f"   [StreamerGirls] [{item_idx}] Error extracting result: {e}")

        if not resolved_url:
            # Try waiting longer and checking again
            await asyncio.sleep(10)
            try:
                resolved_url = await page.evaluate("""
                    () => {
                        let links = document.querySelectorAll('a');
                        for (let a of links) {
                            let href = a.href || '';
                            if (href && !href.includes('bypass.city') && !href.includes('streamergirls') 
                                && !href.includes('javascript:') && href.startsWith('http')) {
                                return href;
                            }
                        }
                        return null;
                    }
                """)
            except Exception:
                pass

        if not resolved_url:
            print(f"   [StreamerGirls] [{item_idx}] [FAIL] Could not resolve download URL via bypass.city")
            return None

        print(f"   [StreamerGirls] [{item_idx}] Resolved to: {resolved_url}")

        # Now download the resolved URL
        try:
            async with page.expect_download(timeout=120000) as dl_promise:
                try:
                    await page.goto(resolved_url, timeout=15000)
                except Exception:
                    pass
                try:
                    download = await asyncio.wait_for(dl_promise.value, timeout=120.0)
                    filename = download.suggested_filename
                    output_path = os.path.join(download_dir, filename)
                    await download.save_as(output_path)
                    file_size = os.path.getsize(output_path)
                    print(f"   [StreamerGirls] [{item_idx}] [OK] Downloaded: {filename} ({file_size / (1024**2):.1f} MB)")
                    return output_path
                except asyncio.TimeoutError:
                    print(f"   [StreamerGirls] [{item_idx}] [FAIL] Download timed out")
                    return None
        except Exception as e:
            print(f"   [StreamerGirls] [{item_idx}] [FAIL] Download error: {e}")
            return None


# ==============================================================================
# DISPATCHER
# ==============================================================================

_HANDLERS = [BalbumsHandler(), CyberfileHandler(), StreamergirlsHandler()]


def get_handler(url):
    """Return the appropriate handler for a URL, or None."""
    for handler in _HANDLERS:
        if handler.can_handle(url):
            return handler
    return None


def get_supported_domains():
    """Return list of domain patterns this module can handle."""
    return ["balbums.st", "bunkr.", "cyberfile.", "streamergirls."]
