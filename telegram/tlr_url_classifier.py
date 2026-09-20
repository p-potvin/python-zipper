"""
URL classification, normalization, and pyLoad queueing extracted from telethon_link_resolver.py.
"""

import re
import requests
from urllib.parse import urlparse, urlunparse


def convert_bunkr_link(url):
    """Convert bunkr.la, bunkr.ru, bunkr.to, bunkr.is, bunkr.cr, etc. to balbums.st"""
    pattern = r'https?://(?:[a-zA-Z0-9-]+\.)?bunkr\.[a-z]+(/.*)?'
    match = re.match(pattern, url, re.IGNORECASE)
    if match:
        path = match.group(1) or ""
        return f"https://balbums.st{path}"
    return url


def normalize_url(url):
    """Strip fragments, query params, and known suffix paths to deduplicate URLs."""
    parsed = urlparse(url)
    path = parsed.path.rstrip('/')
    strip_suffixes = ['/edit', '/raw', '/export-page', '/report-url', '/lang', '/langs',
                      '/how', '/what', '/archive', '/contact', '/login', '/register',
                      '/signup', '/about', '/faq', '/sitemap.xml']
    for suffix in strip_suffixes:
        if path.endswith(suffix):
            path = path[:-len(suffix)]
    normalized = urlunparse((parsed.scheme, parsed.netloc, path, '', '', ''))
    return normalized


def classify_and_filter_url(url):
    """
    Classifies a URL and returns a tuple (action, processed_url)
    Actions: 'rd', 'direct', 'pyload', 'skip'
    """
    url_lower = url.lower()

    if 'fishing' in url_lower:
        return 'skip', None

    skip_domains = [
        'discord.gg', 'discord.com', 't.me', 'telegram.me', 'telegram.org',
        'rentry.co', 'rentry.org',
        'pasterix.com', 'pasterix.net', 'pastehill.com',
        'plugleaksvip.com', 'plugleakz.net',
    ]
    if any(domain in url_lower for domain in skip_domains):
        return 'skip', None

    skip_keywords = [
        '/login', '/register', '/signup', '/contact', '/edit', '/about', '/faq',
        '/archive', '/sitemap', '/lang/', '/pages/', '/how', '/what',
        '/report-url', '/request-login', '/export-page', '/raw',
        '/clone/', '/u/',
    ]
    if any(keyword in url_lower for keyword in skip_keywords):
        return 'skip', None

    if 'mega.nz' in url_lower or 'mega.co.nz' in url_lower:
        return 'mega', url

    parsed = urlparse(url)
    if (not parsed.path or parsed.path == '/') and not parsed.fragment:
        return 'skip', None

    if 'bunkr.' in url_lower:
        return 'direct', url

    if 'cyberfile.' in url_lower:
        return 'direct', url

    if 'balbums.st' in url_lower:
        return 'direct', url

    if 'streamergirls.' in url_lower:
        return 'direct', url

    file_indicators = ['/download/', '/d/', '/file/', '/f/', '/get/', '/dl/',
                       '.mp4', '.zip', '.rar', '.7z', '.mkv', '.avi', '.wmv',
                       '/v/', '/watch/', '/embed/']
    if any(indicator in url_lower for indicator in file_indicators):
        return 'pyload', url

    return 'skip', None


def check_pyload_api(pyload_api_url, pyload_api_key):
    """Check if pyLoad API is accessible. Returns (accessible, enabled_flag)."""
    try:
        headers = {"X-API-Key": pyload_api_key}
        response = requests.get(f"{pyload_api_url}/status_server", headers=headers, timeout=3)
        if response.status_code == 200:
            print(f"[INIT] pyLoad API accessible at {pyload_api_url}")
            return True, True
    except Exception as e:
        print(f"[INIT] pyLoad API not accessible: {str(e)[:60]}")
    return False, False


def queue_links_to_pyload(links, package_name="Failed Downloads",
                           pyload_api_url=None, pyload_api_key=None,
                           pyload_enabled=False, check_api_fn=None):
    """
    Queue a list of links to pyLoad as a single package.
    Returns dict with status and package_id if successful.
    """
    if not links or len(links) == 0:
        print(f"   [pyLoad] No links to queue")
        return None

    if not pyload_enabled:
        if check_api_fn:
            _, pyload_enabled = check_api_fn()
        if not pyload_enabled:
            print(f"   [pyLoad] ✗ API not available at {pyload_api_url}")
            return None

    try:
        package_data = {
            "name": package_name,
            "links": links
        }

        print(f"   [pyLoad] Queueing {len(links)} links to package: {package_name}")

        response = requests.post(
            f"{pyload_api_url}/add_package",
            json=package_data,
            headers={"X-API-Key": pyload_api_key},
            timeout=10
        )

        if response.status_code in [200, 201]:
            try:
                result = response.json()
            except Exception:
                result = response.text.strip()
            if isinstance(result, dict):
                package_id = result.get('pid') or result.get('package_id') or result.get('id')
            else:
                package_id = result
            print(f"   [pyLoad] ✓ Package created: {package_name} (ID: {package_id})")
            return {
                'status': 'success',
                'package_id': package_id,
                'package_name': package_name,
                'links_count': len(links)
            }
        elif response.status_code == 401:
            print(f"   [pyLoad] ✗ Authentication failed - pyLoad may require login")
            return None
        else:
            print(f"   [pyLoad] ✗ Failed to create package: {response.status_code}")
            return None

    except Exception as e:
        print(f"   [pyLoad] ✗ Error queueing links: {str(e)[:100]}")
        return None
