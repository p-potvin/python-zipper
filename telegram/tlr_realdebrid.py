"""
Real-Debrid and MEGA helpers extracted from telethon_link_resolver.py.
"""

import os
import re
import asyncio
import requests


def unrestrict_mega_with_realdebrid(mega_url, item_idx, realdebrid_api_token, realdebrid_api_base="https://api.real-debrid.com/rest/1.0"):
    """Uses Real-Debrid API to unrestrict a MEGA link and get direct download URL"""
    if not realdebrid_api_token:
        print(f"   [{item_idx}] ✗ Real-Debrid API token not loaded")
        return None

    try:
        print(f"   [{item_idx}] Unrestricting MEGA link with Real-Debrid API...")

        headers = {
            'Authorization': f'Bearer {realdebrid_api_token}',
            'User-Agent': 'Mozilla/5.0'
        }

        payload = {'link': mega_url}

        response = requests.post(
            f"{realdebrid_api_base}/unrestrict/link",
            headers=headers,
            data=payload,
            timeout=10
        )

        if response.status_code == 200:
            data = response.json()
            download_url = data.get('download')
            filename = data.get('filename', 'unknown')
            filesize = data.get('filesize', 0)

            print(f"   [{item_idx}] ✓ Real-Debrid unrestricted link")
            print(f"   [{item_idx}]   Filename: {filename}")
            print(f"   [{item_idx}]   Size: {filesize / (1024**3):.2f} GB")

            return {
                'download_url': download_url,
                'filename': filename,
                'filesize': filesize,
                'original_mega': mega_url
            }
        elif response.status_code == 401:
            print(f"   [{item_idx}] ✗ Real-Debrid authentication failed (invalid token)")
            return None
        else:
            print(f"   [{item_idx}] ✗ Real-Debrid API error {response.status_code}: {response.text}")
            return None

    except requests.exceptions.Timeout:
        print(f"   [{item_idx}] ✗ Real-Debrid request timeout")
        return None
    except Exception as e:
        print(f"   [{item_idx}] ✗ Real-Debrid unrestriction failed: {str(e)}")
        return None


async def expand_mega_folder(mega_folder_url, browser=None):
    """Expand MEGA folder link to individual file links"""
    print(f"   Expanding MEGA folder: {mega_folder_url}...")

    try:
        match = re.search(r'mega.nz/folder/([^#]+)#([\w-]+)', mega_folder_url)
        if not match:
            print(f"   ⚠️  Could not parse MEGA folder URL")
            return []

        folder_id, folder_key = match.groups()
        print(f"   Folder ID: {folder_id}")
        print(f"   Trying MEGA API to expand folder...")

        try:
            api_response = requests.post(
                'https://g.api.mega.co.nz/cs',
                json=[{'a': 'f', 'c': 1, 'r': 1, 'ca': [folder_id + ':' + folder_key]}],
                timeout=10
            )
            if api_response.status_code == 200:
                data = api_response.json()
                print(f"   ✓ MEGA API responded")
        except Exception:
            pass

        if browser:
            print(f"   Using browser to extract files from folder...")
            print(f"   ⚠️  Browser-based folder expansion not yet implemented")

        print(f"   ⚠️  Unable to expand folder automatically")
        return [mega_folder_url]

    except Exception as e:
        print(f"   ✗ Expansion failed: {str(e)}")
        return [mega_folder_url]


async def mega_folder_rd_extension_automation(page, mega_url, browser, item_idx, output_dir=None):
    """
    Navigate to a mega.nz folder, click the Real-Debrid extension icon in the toolbar,
    click 'unrestrict links', then 'copy links', and read the clipboard.
    Returns a list of unrestricted download URLs.
    """
    try:
        import pyautogui
        import pyperclip
    except ImportError:
        print(f"   [{item_idx}] [WARN] pyautogui/pyperclip not installed, falling back to API")
        return []

    print(f"   [{item_idx}] [MEGA FOLDER] Navigating to {mega_url}")

    try:
        await page.goto(mega_url, timeout=20000)
    except Exception as e:
        print(f"   [{item_idx}] [WARN] Navigation error: {str(e)[:80]}")

    await asyncio.sleep(5)

    rd_icon_x = int(os.environ.get("RD_EXTENSION_X", 0))
    rd_icon_y = int(os.environ.get("RD_EXTENSION_Y", 0))

    if rd_icon_x == 0 or rd_icon_y == 0:
        print(f"   [{item_idx}] [WARN] RD extension icon position not configured (set RD_EXTENSION_X and RD_EXTENSION_Y env vars)")
        return []

    print(f"   [{item_idx}] [MEGA FOLDER] Clicking RD extension icon at ({rd_icon_x}, {rd_icon_y})...")
    pyautogui.click(rd_icon_x, rd_icon_y)
    await asyncio.sleep(3)

    unrestrict_x = int(os.environ.get("RD_UNRESTRICT_X", 0))
    unrestrict_y = int(os.environ.get("RD_UNRESTRICT_Y", 0))

    if unrestrict_x == 0 or unrestrict_y == 0:
        print(f"   [{item_idx}] [WARN] 'Unrestrict links' button position not configured")
        pyautogui.press('Escape')
        await asyncio.sleep(1)
        return []

    print(f"   [{item_idx}] [MEGA FOLDER] Clicking 'Unrestrict links' at ({unrestrict_x}, {unrestrict_y})...")
    pyautogui.click(unrestrict_x, unrestrict_y)
    await asyncio.sleep(10)

    copy_x = int(os.environ.get("RD_COPY_X", 0))
    copy_y = int(os.environ.get("RD_COPY_Y", 0))

    if copy_x == 0 or copy_y == 0:
        print(f"   [{item_idx}] [WARN] 'Copy links' button position not configured")
        pyautogui.press('Escape')
        await asyncio.sleep(1)
        return []

    print(f"   [{item_idx}] [MEGA FOLDER] Clicking 'Copy links' at ({copy_x}, {copy_y})...")
    pyautogui.click(copy_x, copy_y)
    await asyncio.sleep(2)

    pyautogui.press('Escape')
    await asyncio.sleep(1)

    clipboard_content = pyperclip.paste()
    if not clipboard_content:
        print(f"   [{item_idx}] [WARN] Clipboard is empty after 'Copy links'")
        return []

    urls = [line.strip() for line in clipboard_content.split('\n') if line.strip().startswith('http')]

    if urls:
        print(f"   [{item_idx}] [MEGA FOLDER] ✓ Got {len(urls)} unrestricted URLs from clipboard")
        if output_dir:
            rd_links_file = os.path.join(output_dir, "mega_folder_rd_links.txt")
            with open(rd_links_file, "a", encoding="utf-8") as f:
                for u in urls:
                    f.write(u + "\n")
            print(f"   [{item_idx}] [MEGA FOLDER] Written to {rd_links_file}")
    else:
        print(f"   [{item_idx}] [WARN] No URLs found in clipboard content")

    return urls
