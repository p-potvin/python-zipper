"""
AllDebrid API integration module for unlocking MEGA links, expanding folders,
and generating M3U streaming playlists.

Docs: https://docs.alldebrid.com/
Credentials: C:\\Users\\Administrator\\Desktop\\Github Repos\\.access\\alldebrid.token.txt
"""

import os
import sys
import re
import time
import json
import requests
from typing import Optional, List, Dict, Any, Tuple
from urllib.parse import urlparse

# Ensure UTF-8 output encoding for Windows CP1252 terminals
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

DEFAULT_TOKEN_PATH = r"C:\Users\Administrator\Desktop\Github Repos\.access\alldebrid.token.txt"
DEFAULT_API_BASE = "https://api.alldebrid.com/v4"
DEFAULT_AGENT = "python-zipper"


def get_alldebrid_token(token_path: Optional[str] = None) -> Optional[str]:
    """
    Retrieve AllDebrid API key from environment variable or token file.
    """
    env_token = os.environ.get("ALLDEBRID_API_KEY", "").strip()
    if env_token:
        return env_token

    path = token_path or os.environ.get("ALLDEBRID_TOKEN_PATH", DEFAULT_TOKEN_PATH)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                token = f.read().strip()
                if token:
                    return token
        except Exception as e:
            print(f"[AllDebrid] Error reading token file {path}: {e}")
    return None


def get_auth_headers(api_key: Optional[str] = None) -> Dict[str, str]:
    """Build HTTP headers for AllDebrid authenticated API requests."""
    key = api_key or get_alldebrid_token()
    headers = {
        "User-Agent": "python-zipper/1.0",
        "Accept": "application/json",
    }
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def check_alldebrid_auth(api_key: Optional[str] = None, api_base: str = DEFAULT_API_BASE) -> Tuple[bool, Dict[str, Any]]:
    """
    Check if the AllDebrid API key is valid and account is active.
    Returns (is_valid, data_or_error_dict).
    """
    token = api_key or get_alldebrid_token()
    if not token:
        return False, {"error": "Missing API key in .access/alldebrid.token.txt or ALLDEBRID_API_KEY env"}

    headers = get_auth_headers(token)
    try:
        resp = requests.get(f"{api_base}/user", headers=headers, params={"agent": DEFAULT_AGENT}, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("status") == "success":
                user_info = data.get("data", {}).get("user", {})
                return True, user_info
            else:
                err = data.get("error", {})
                return False, {"error": f"{err.get('code')}: {err.get('message')}"}
        return False, {"error": f"HTTP {resp.status_code}: {resp.text}"}
    except Exception as e:
        return False, {"error": f"Connection exception: {str(e)}"}


def unlock_link_alldebrid(
    link: str,
    api_key: Optional[str] = None,
    api_base: str = DEFAULT_API_BASE,
    password: Optional[str] = None,
    max_poll_time: int = 60
) -> Optional[Dict[str, Any]]:
    """
    Unrestrict a single link using the AllDebrid API (/link/unlock).
    Handles delayed links automatically by polling /link/delayed.
    """
    token = api_key or get_alldebrid_token()
    if not token:
        print("[AllDebrid] ✗ No API key available")
        return None

    headers = get_auth_headers(token)
    payload = {
        "link": link,
        "agent": DEFAULT_AGENT
    }
    if password:
        payload["password"] = password

    try:
        resp = requests.post(f"{api_base}/link/unlock", headers=headers, data=payload, timeout=15)
        if resp.status_code != 200:
            print(f"[AllDebrid] ✗ HTTP {resp.status_code} unlocking {link}")
            return None

        res_json = resp.json()
        if res_json.get("status") != "success":
            err = res_json.get("error", {})
            print(f"[AllDebrid] ✗ Unlock error for {link}: {err.get('code')} - {err.get('message')}")
            return None

        data = res_json.get("data", {})
        
        # Check if link is ready immediately
        download_url = data.get("link")
        filename = data.get("filename", "unnamed_file")
        filesize = data.get("filesize", 0)
        host = data.get("host", "mega")
        link_id = data.get("id")

        # Handle delayed link flow
        delayed_id = data.get("delayed")
        if not download_url and delayed_id:
            print(f"[AllDebrid] Link delayed (ID: {delayed_id}). Polling for readiness...")
            start_time = time.time()
            while time.time() - start_time < max_poll_time:
                time.sleep(3)
                poll_resp = requests.post(
                    f"{api_base}/link/delayed",
                    headers=headers,
                    data={"id": delayed_id, "agent": DEFAULT_AGENT},
                    timeout=10
                )
                if poll_resp.status_code == 200:
                    poll_json = poll_resp.json()
                    poll_data = poll_json.get("data", {})
                    poll_status = poll_data.get("status")
                    if poll_status == 2:  # Ready
                        download_url = poll_data.get("link")
                        filename = poll_data.get("filename", filename)
                        filesize = poll_data.get("filesize", filesize)
                        print(f"[AllDebrid] ✓ Delayed link ready: {filename}")
                        break
                    elif poll_status == 3:  # Failed
                        print(f"[AllDebrid] ✗ Delayed link failed on AllDebrid side")
                        return None
                else:
                    print(f"[AllDebrid] ⚠️ Delayed poll status {poll_resp.status_code}")

        if download_url:
            return {
                "link": download_url,
                "filename": filename,
                "filesize": filesize,
                "host": host,
                "id": link_id,
                "original_link": link,
            }
        else:
            print(f"[AllDebrid] ⚠️ No download URL generated for {link}")
            return None

    except Exception as e:
        print(f"[AllDebrid] ✗ Error unlocking {link}: {e}")
        return None


def extract_redirector_links_alldebrid(
    folder_url: str,
    api_key: Optional[str] = None,
    api_base: str = DEFAULT_API_BASE
) -> List[str]:
    """
    Extract individual links inside a folder/protector via AllDebrid /link/redirector.
    Returns list of virtual redirect links (or original URLs).
    """
    token = api_key or get_alldebrid_token()
    if not token:
        print("[AllDebrid] ✗ No API key available for folder redirector")
        return []

    headers = get_auth_headers(token)
    payload = {
        "link": folder_url,
        "agent": DEFAULT_AGENT
    }

    try:
        resp = requests.post(f"{api_base}/link/redirector", headers=headers, data=payload, timeout=20)
        if resp.status_code == 200:
            res_json = resp.json()
            if res_json.get("status") == "success":
                links = res_json.get("data", {}).get("links", [])
                print(f"[AllDebrid] ✓ Redirector extracted {len(links)} item(s) from folder")
                return links
            else:
                err = res_json.get("error", {})
                print(f"[AllDebrid] ✗ Redirector error: {err.get('code')} - {err.get('message')}")
        else:
            print(f"[AllDebrid] ✗ Redirector HTTP {resp.status_code}: {resp.text}")
    except Exception as e:
        print(f"[AllDebrid] ✗ Exception in redirector for {folder_url}: {e}")

    return []


EMOJI_PATTERN = re.compile(
    r'[\U00010000-\U0010FFFF\u2600-\u27BF\u2300-\u23FF\u2B50\u2B55\u2934\u2935\u2B05\u2B06\u2B07\u3030\u303D\u3297\u3299\uFE00-\uFE0F\u200D\u20E3]+',
    flags=re.UNICODE
)


def clean_telegram_first_line(text: Optional[str]) -> str:
    """
    Extract the first line of a Telegram message and strip emojis,
    symbols, and surrounding markdown/punctuation formatting.
    """
    if not text:
        return ""
    first_line = text.strip().splitlines()[0].strip()
    cleaned = EMOJI_PATTERN.sub("", first_line)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip(" -—_~|•*#\t\r\n")
    return cleaned


def format_smart_filename(
    mega_filename: str,
    telegram_title: Optional[str],
    item_index: Optional[int] = None,
    total_items: Optional[int] = None
) -> str:
    """
    Replace the entire mega file title (except the number/suffix in parenthesis at the end
    and the extension) with the cleaned first line of the Telegram message.
    """
    if not telegram_title:
        return mega_filename

    clean_title = clean_telegram_first_line(telegram_title)
    if not clean_title:
        return mega_filename

    base, ext = os.path.splitext(mega_filename)

    # Match parenthesis at the end, e.g. " (1)", "(02)", " (3)"
    paren_match = re.search(r'(\s*\(\s*\d+\s*\))\s*$', base)
    if not paren_match:
        # Fallback to general parenthesis if digits weren't strictly matched
        paren_match = re.search(r'(\s*\([^)]+\))\s*$', base)

    if paren_match:
        paren_suffix = paren_match.group(1).strip()
        smart_name = f"{clean_title} ({paren_suffix.strip('()')}){ext}"
    elif total_items and total_items > 1 and item_index is not None:
        smart_name = f"{clean_title} ({item_index}){ext}"
    else:
        smart_name = f"{clean_title}{ext}"

    return smart_name


ALLOWED_VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts', '.m4v', '.flv', '.wmv'}
ALLOWED_IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'}
ALLOWED_MEDIA_EXTENSIONS = ALLOWED_VIDEO_EXTENSIONS | ALLOWED_IMAGE_EXTENSIONS


def is_allowed_media_file(filename_or_url: str) -> bool:
    """Return True if filename or URL has a supported video or image extension."""
    if not filename_or_url:
        return False
    path_part = urlparse(filename_or_url).path if ('/' in filename_or_url or '\\' in filename_or_url) else filename_or_url
    ext = os.path.splitext(path_part.lower())[1]
    return ext in ALLOWED_MEDIA_EXTENSIONS


def sanitize_filename(name: str) -> str:
    """Sanitize string to be safe for filenames."""
    clean = re.sub(r'[\\/*?:"<>|]', "_", name)
    clean = clean.strip().strip(".")
    return clean or "playlist"


def generate_m3u_playlist(
    items: List[Dict[str, Any]],
    title: str,
    output_path: Optional[str] = None,
    group_title: Optional[str] = None,
    telegram_title: Optional[str] = None
) -> Tuple[str, str]:
    """
    Generate an M3U8 playlist and JSON manifest file for the given unlocked items,
    applying smart naming from the Telegram post title.
    
    Format:
    #EXTM3U
    #EXTINF:-1 tvg-name="Smart Title (1).mp4" group-title="Smart Title",Smart Title (1).mp4 (100.0 MB)
    https://...
    
    Returns (m3u_file_path, json_manifest_path).
    """
    clean_title = clean_telegram_first_line(telegram_title or title) or title
    effective_group = group_title or clean_title

    # Filter out non-media items (.txt, .exe, .nfo, .pdf, etc.)
    media_items = [
        itm for itm in items
        if is_allowed_media_file(itm.get("original_filename") or itm.get("filename", "") or itm.get("link", ""))
    ]
    if media_items:
        items = media_items

    if not output_path:
        zipper_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        playlists_dir = os.path.join(zipper_root, "playlists")
        os.makedirs(playlists_dir, exist_ok=True)
        safe_title = sanitize_filename(clean_title)
        output_path = os.path.join(playlists_dir, f"{safe_title}.m3u")
    else:
        out_dir = os.path.dirname(output_path)
        if out_dir and not os.path.exists(out_dir):
            os.makedirs(out_dir, exist_ok=True)

    lines = ["#EXTM3U\n"]
    for idx, item in enumerate(items, 1):
        if item.get("smart_filename"):
            smart_fn = item["smart_filename"]
        else:
            orig_fn = item.get("original_filename") or item.get("filename") or "video.mp4"
            smart_fn = format_smart_filename(
                mega_filename=orig_fn,
                telegram_title=clean_title,
                item_index=idx,
                total_items=len(items)
            )
            item["original_filename"] = orig_fn
            item["smart_filename"] = smart_fn
            item["filename"] = smart_fn  # Update primary display filename

        url = item.get("link")
        size = item.get("filesize", 0)
        size_mb = f" ({size / (1024**2):.1f} MB)" if size else ""
        lines.append(f'#EXTINF:-1 tvg-name="{smart_fn}" group-title="{effective_group}",{smart_fn}{size_mb}\n')
        lines.append(f"{url}\n")

    with open(output_path, "w", encoding="utf-8") as f:
        f.writelines(lines)

    # Save JSON sidecar metadata for M3U playlist browser
    json_path = os.path.splitext(output_path)[0] + ".json"
    metadata = {
        "title": clean_title,
        "group_title": effective_group,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "total_items": len(items),
        "playlist_m3u": output_path,
        "items": items,
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)

    print(f"[AllDebrid] ✓ Generated M3U playlist: {output_path}")
    print(f"[AllDebrid] ✓ Generated JSON manifest: {json_path}")
    return output_path, json_path


def process_mega_folder_alldebrid(
    mega_folder_url: str,
    output_dir: Optional[str] = None,
    playlists_dir: Optional[str] = None,
    api_key: Optional[str] = None,
    custom_title: Optional[str] = None
) -> Dict[str, Any]:
    """
    Full pipeline to process a MEGA folder link via AllDebrid:
    1. Extract all item redirect URLs inside the folder.
    2. Unlock each individual item to get direct high-speed streaming links.
    3. Apply Telegram-derived smart naming to all items.
    4. Generate and save the .m3u playlist file and JSON metadata in python-zipper.
    5. Return full stream results.
    """
    token = api_key or get_alldebrid_token()
    print(f"\n[AllDebrid] === Processing MEGA Folder ===")
    print(f"[AllDebrid] URL: {mega_folder_url}")

    # Derive folder title/id and clean Telegram title
    match = re.search(r'mega\.nz/folder/([^#]+)#([\w-]+)', mega_folder_url)
    folder_id = match.group(1) if match else "mega_folder"

    clean_title = clean_telegram_first_line(custom_title)
    if not clean_title:
        clean_title = f"MegaFolder_{folder_id}_{int(time.time())}"

    # 1. Extract links via redirector
    redirect_links = extract_redirector_links_alldebrid(mega_folder_url, api_key=token)
    if not redirect_links:
        print(f"[AllDebrid] ⚠️ No links returned by redirector. Trying direct unlock...")
        redirect_links = [mega_folder_url]

    # 2. Unlock each link
    unlocked_items = []
    print(f"[AllDebrid] Unlocking {len(redirect_links)} extracted links...")
    for idx, r_link in enumerate(redirect_links, 1):
        print(f"   [{idx}/{len(redirect_links)}] Unlocking link...")
        unlocked = unlock_link_alldebrid(r_link, api_key=token)
        if unlocked:
            fn = unlocked.get("filename", "")
            if not is_allowed_media_file(fn):
                print(f"      ⊘ Skipping non-media file: {fn}")
                continue
            smart_fn = format_smart_filename(
                mega_filename=fn or "video.mp4",
                telegram_title=clean_title,
                item_index=idx,
                total_items=len(redirect_links)
            )
            unlocked["original_filename"] = fn
            unlocked["smart_filename"] = smart_fn
            unlocked["filename"] = smart_fn
            unlocked_items.append(unlocked)
            print(f"      ✓ {smart_fn} ({unlocked.get('filesize', 0)/(1024**2):.1f} MB)")
        else:
            print(f"      ✗ Failed to unlock item {idx}")

    if not unlocked_items:
        print(f"[AllDebrid] ✗ No items could be unlocked from MEGA folder")
        return {
            "status": "error",
            "folder_url": mega_folder_url,
            "error": "No items unlocked",
            "items": [],
            "unrestricted_urls": [],
        }

    # 3. Determine playlist output path
    zipper_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    target_playlists_dir = playlists_dir or os.path.join(zipper_root, "playlists")
    os.makedirs(target_playlists_dir, exist_ok=True)
    m3u_file_path = os.path.join(target_playlists_dir, f"{sanitize_filename(clean_title)}.m3u")

    # 4. Generate M3U playlist and JSON manifest
    m3u_path, json_path = generate_m3u_playlist(
        items=unlocked_items,
        title=clean_title,
        output_path=m3u_file_path,
        group_title=clean_title,
        telegram_title=clean_title
    )

    # Also optionally append direct links to output_dir file if requested
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
        ad_links_file = os.path.join(output_dir, "alldebrid_unrestricted_links.txt")
        with open(ad_links_file, "a", encoding="utf-8") as f:
            for item in unlocked_items:
                f.write(f"{item['link']}\n")
        print(f"[AllDebrid] Appended {len(unlocked_items)} links to {ad_links_file}")

    return {
        "status": "success",
        "folder_url": mega_folder_url,
        "title": clean_title,
        "folder_id": folder_id,
        "total_items": len(unlocked_items),
        "playlist_path": m3u_path,
        "json_path": json_path,
        "items": unlocked_items,
        "unrestricted_urls": [item["link"] for item in unlocked_items],
    }


def process_mega_url(
    url: str,
    output_dir: Optional[str] = None,
    playlists_dir: Optional[str] = None,
    api_key: Optional[str] = None,
    custom_title: Optional[str] = None
) -> Dict[str, Any]:
    """
    Handle any MEGA URL (folder or individual file) via AllDebrid.
    If it's a folder, expands and generates an M3U playlist.
    If it's a single file, unlocks and returns stream/download info.
    """
    url_lower = url.lower()
    if "/folder/" in url_lower:
        return process_mega_folder_alldebrid(
            url,
            output_dir=output_dir,
            playlists_dir=playlists_dir,
            api_key=api_key,
            custom_title=custom_title
        )
    else:
        # Single file
        print(f"\n[AllDebrid] Unlocking single MEGA file: {url}")
        unlocked = unlock_link_alldebrid(url, api_key=api_key)
        if unlocked:
            clean_title = clean_telegram_first_line(custom_title)
            if clean_title:
                smart_fn = format_smart_filename(unlocked.get("filename", "mega_file"), clean_title)
                unlocked["original_filename"] = unlocked.get("filename")
                unlocked["smart_filename"] = smart_fn
                unlocked["filename"] = smart_fn
                title = clean_title
            else:
                title = os.path.splitext(unlocked.get("filename", "mega_file"))[0]

            # Also generate a single-item M3U playlist
            zipper_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
            target_playlists_dir = playlists_dir or os.path.join(zipper_root, "playlists")
            m3u_path = os.path.join(target_playlists_dir, f"{sanitize_filename(title)}.m3u")
            m3u_path, json_path = generate_m3u_playlist(
                items=[unlocked],
                title=title,
                output_path=m3u_path,
                group_title=title,
                telegram_title=custom_title
            )
            return {
                "status": "success",
                "url": url,
                "title": title,
                "total_items": 1,
                "playlist_path": m3u_path,
                "json_path": json_path,
                "items": [unlocked],
                "unrestricted_urls": [unlocked["link"]],
            }
        return {
            "status": "error",
            "url": url,
            "error": "Failed to unlock single file",
            "items": [],
            "unrestricted_urls": [],
        }
