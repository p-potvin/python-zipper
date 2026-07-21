"""
Linkvertise bypass and rentry extraction extracted from telethon_link_resolver.py.
"""

import os
import asyncio
import requests
from urllib.parse import quote


def bypass_linkvertise_with_api(linkvertise_url, page_idx, rip_api_key="", rip_api_endpoint="https://trw.lat/api/bypass"):
    """Uses RIP Linkvertise API to bypass and extract rentry.co link - DEPRECATED"""
    print(f"   [{page_idx}] [WARN] API bypass method deprecated - requires browser automation")
    return None


async def bypass_linkvertise_in_browser(linkvertise_url, browser, page_idx, rip_api_key=""):
    """Uses TRW and backup REST APIs to extract the rentry/pasterix link."""
    encoded_url = quote(linkvertise_url, safe='')

    bypass_services = [
        {"endpoint": "https://trw.lat/api/bypass", "url_param": "url", "key_param": "apikey", "key_value": rip_api_key},
        {"endpoint": "https://api.bypass.vip/bypass", "url_param": "url", "key_param": "key", "key_value": ""},
        {"endpoint": "https://free.bypass-api.com/bypass", "url_param": "url", "key_param": "apikey", "key_value": ""}
    ]

    for service in bypass_services:
        endpoint = service["endpoint"]
        url_param = service["url_param"]
        key_param = service["key_param"]
        key_value = service["key_value"]

        print(f"   [{page_idx}] Requesting Linkvertise bypass via {endpoint}...")

        params = {url_param: linkvertise_url}
        if key_param and key_value:
            params[key_param] = key_value

        rate_limit_retries = 0
        max_rate_limit_retries = 5

        while rate_limit_retries < max_rate_limit_retries:
            try:
                resp = requests.get(endpoint, params=params, timeout=15)

                if resp.status_code == 200:
                    data = resp.json()
                    res_link = None
                    if data.get('success'):
                        res_link = data.get('result') or data.get('destination')
                    elif 'destination' in data:
                        res_link = data['destination']
                    elif 'result' in data:
                        res_link = data['result']

                    if res_link:
                        res_link_lower = res_link.lower()
                        if res_link_lower.startswith("http") and not any(msg in res_link_lower for msg in ["discord", "shut down", "api limit", "leechers"]):
                            print(f"   [{page_idx}] [OK] Extracted link: {res_link}")
                            return res_link
                        else:
                            print(f"   [{page_idx}] [FAIL] Extracted link failed validation (garbage/invite): {res_link}")
                            break

                    print(f"   [{page_idx}] [FAIL] Service response failed validation: {data}")
                    break

                elif resp.status_code == 202:
                    rate_limit_retries += 1
                    print(f"   [{page_idx}] [WARN] Service returned 202, waiting 5s (retry {rate_limit_retries}/{max_rate_limit_retries})...")
                    await asyncio.sleep(5)
                elif resp.status_code == 429:
                    rate_limit_retries += 1
                    print(f"   [{page_idx}] [WARN] Rate limit 429, waiting 10s (retry {rate_limit_retries}/{max_rate_limit_retries})...")
                    await asyncio.sleep(10)
                elif resp.status_code >= 400:
                    print(f"   [{page_idx}] [FAIL] Service HTTP {resp.status_code}: {resp.text[:200]}")
                    break
                else:
                    print(f"   [{page_idx}] [FAIL] Unknown status: {resp.status_code}")
                    break

            except Exception as e:
                print(f"   [{page_idx}] [FAIL] Request to {endpoint} error: {str(e)[:100]}")
                break

    print(f"   [{page_idx}] ✗ All Linkvertise bypass services failed.")
    return None


async def extract_mega_from_rentry(rentry_url, browser, page_idx, artifacts_dir=None):
    """Opens rentry.co link in browser and extracts mega.nz link"""
    page = None
    try:
        print(f"   [{page_idx}] Opening rentry.co link in browser (8s timeout)...")
        page = await browser.new_page()

        await page.goto(rentry_url, wait_until="domcontentloaded", timeout=8000)
        print(f"   [{page_idx}] Page loaded, extracting mega link...")
        await asyncio.sleep(1)

        mega_link = await page.evaluate(r"""
            () => {
                const links = Array.from(document.querySelectorAll('a'));
                for (let link of links) {
                    if (link.href && link.href.includes('mega.nz')) {
                        return link.href;
                    }
                }
                const pageText = document.body.innerText;
                const megaMatch = pageText.match(/https:\/\/mega\.nz\/[^\s]+/);
                if (megaMatch) {
                    return megaMatch[0];
                }
                return null;
            }
        """)

        if mega_link and 'mega.nz' in mega_link:
            print(f"   [{page_idx}] ✓ Found mega.nz link: {mega_link}")
            return mega_link
        else:
            print(f"   [{page_idx}] ⚠️  No mega.nz link found on rentry page")
            print(f"   [{page_idx}] Waiting 1 second for dynamic content...")
            await asyncio.sleep(1)

            mega_link = await page.evaluate(r"""
                () => {
                    const pageText = document.body.innerText;
                    const megaMatch = pageText.match(/https:\/\/mega\.nz\/[^\s]+/);
                    if (megaMatch) {
                        return megaMatch[0];
                    }
                    return null;
                }
            """)

            if mega_link:
                print(f"   [{page_idx}] ✓ Found mega link after waiting: {mega_link}")
                return mega_link

            if artifacts_dir:
                debug_screenshot = os.path.join(artifacts_dir, f"debug_rentry_page_{page_idx}.png")
                await page.screenshot(path=debug_screenshot)
                print(f"   [{page_idx}] Saved page screenshot to {debug_screenshot}")

            return None

    except asyncio.TimeoutError:
        print(f"   [{page_idx}] ✗ Page load timeout (10s exceeded)")
        return None
    except Exception as e:
        print(f"   [{page_idx}] ✗ Failed to extract mega link from rentry: {str(e)}")
        import traceback
        traceback.print_exc()
        return None
    finally:
        if page:
            await page.close()


async def extract_links_from_rentry(rentry_url, browser, page_idx):
    """Extract all links from a Rentry page (not just mega.nz)"""
    page = None
    try:
        print(f"   [{page_idx}] Extracting all links from Rentry page...")
        page = await browser.new_page()

        await page.goto(rentry_url, wait_until="domcontentloaded", timeout=8000)
        await asyncio.sleep(1)

        all_links = await page.evaluate(r"""
            () => {
                const links = new Set();
                document.querySelectorAll('a[href]').forEach(a => {
                    const href = a.href.trim();
                    if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
                        links.add(href);
                    }
                });
                const pageText = document.body.innerText;
                const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
                const matches = pageText.match(urlPattern);
                if (matches) {
                    matches.forEach(url => links.add(url));
                }
                return Array.from(links);
            }
        """)

        print(f"   [{page_idx}] Found {len(all_links) if all_links else 0} total links on page")
        return all_links if all_links else []

    except Exception as e:
        print(f"   [{page_idx}] [WARN] Error extracting links from Rentry: {e}")
        return []
    finally:
        if page:
            await page.close()
