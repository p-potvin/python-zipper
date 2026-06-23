import os
import sys
import asyncio

# Ensure UTF-8 output encoding for Windows CP1252 terminals
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

import requests
import datetime
import random
import math
import re
import shutil
from urllib.parse import quote
from telethon import TelegramClient
from telethon.tl.types import MessageEntityUrl, MessageEntityTextUrl
from playwright.async_api import async_playwright
from playwright_stealth import Stealth
import win11toast
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from dotenv import load_dotenv
from k2s_uploader import upload_file_dual, is_token_valid

# ==============================================================================
# CONFIGURATION
# 1. Go to https://my.telegram.org and log in with your phone number.
# 2. Click under "API Development tools".
# 3. Copy your api_id and api_hash down below.
# ==============================================================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# Load environment variables from .env file
load_dotenv(os.path.join(SCRIPT_DIR, ".env"))

API_ID = int(os.environ.get("TELEGRAM_API_ID", 0))               # <--- REPLACE: integer
API_HASH = os.environ.get("TELEGRAM_API_HASH", "")     # <--- REPLACE: string

# Choose the channel or user you want to scrape.
# You can use: channel username ('@channelname'), channel ID (integer or string: '123456' or -1001234567890), link, or 'me'.
# Use tuple syntax for multiple channels: ('@channel1', '123456', 'https://t.me/channel2')
CHANNEL_NAME = ('@ThePlugLeaks', 'SPRO', "StreamerGirls.net Official 2")

# Maximum number of recent messages to look at
MESSAGE_LIMIT = 5

# Skip first N messages (to avoid re-processing same links)
# Change this to process different messages each run
MESSAGE_SKIP = 0

# Create output and artifacts directories
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")
ARTIFACTS_DIR = os.path.join(SCRIPT_DIR, "artifacts")
SESSIONS_DIR = os.path.join(SCRIPT_DIR, "sessions")
ASSETS_DIR = os.path.join(SCRIPT_DIR, "assets")

for dir_path in [OUTPUT_DIR, ARTIFACTS_DIR, SESSIONS_DIR]:
    if not os.path.exists(dir_path):
        os.makedirs(dir_path)

OUTPUT_FILE = os.path.join(OUTPUT_DIR, "resolved_links.txt")

# Bind the session file statically to the script's directory so you don't have to re-login if the execution directory changes
SESSION_NAME = os.path.join(SESSIONS_DIR, "automated_scraper_session")

# Persistent browser profile directory (stores cookies, localStorage, cache, Google login)
BROWSER_PROFILE_DIR = os.path.join(SCRIPT_DIR, "browser_profile")
if not os.path.exists(BROWSER_PROFILE_DIR):
    os.makedirs(BROWSER_PROFILE_DIR)

# RIP Linkvertise API configuration
RIP_API_KEY = os.environ.get("TRW_API_KEY", "")
RIP_API_ENDPOINT = 'https://trw.lat/api/bypass'

# We'll use standard Firefox or Chromium for browser automation
STANDARD_FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
STANDARD_CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
FIREFOX_AVAILABLE = os.path.exists(STANDARD_FIREFOX)
CHROME_AVAILABLE = os.path.exists(STANDARD_CHROME)

# Real-Debrid API configuration
REALDEBRID_API_TOKEN = os.environ.get("REALDEBRID_API_KEY", "")
REALDEBRID_API_BASE = "https://api.real-debrid.com/rest/1.0"

# Katfile API configuration
KATFILE_API_KEY = os.environ.get("KATFILE_API_KEY", "")
KATFILE_API_BASE = "https://katfile.space/api"
KATFILE_UPLOAD_SERVER_ENDPOINT = "https://katfile.space/api/upload/server"
KATFILE_DOMAIN = "https://katfile.space"

# pyLoad configuration
PYLOAD_API_URL = os.environ.get("PYLOAD_API_URL", "https://pyload.vaultwares.ca/api")
PYLOAD_API_KEY = os.environ.get("PYLOAD_API_KEY", "pl_11qb0iw6-Pdm9hf1lhqS4y_0vOBnjaunDZZdGNE97S0QQ")
PYLOAD_ENABLED = False  # Will be set to True if API is accessible

DOWNLOAD_DIR = r"G:\mega"

# Large file handling: 3GB-10GB → G:\TelethonDownloads instead of uploading to Katfile
MAX_FILESIZE_UPLOAD = 3 * 1024 * 1024 * 1024  # 3 GB (upload limit before downloading)
MAX_FILESIZE_DOWNLOAD = 10 * 1024 * 1024 * 1024  # 10 GB (max file we'll download)
LARGE_FILE_DOWNLOAD_DIR = r"G:\TelethonDownloads"

# Katfile daily upload limit: 2GB → fallback to G: drive
KATFILE_DAILY_LIMIT = 2 * 1024 * 1024 * 1024  # 2 GB daily upload limit
KATFILE_UPLOAD_DIR = r"G:\KatfileOverflow"  # Fallback directory when daily limit reached

# Ensure directories exist
if not os.path.exists(LARGE_FILE_DOWNLOAD_DIR):
    os.makedirs(LARGE_FILE_DOWNLOAD_DIR)
    print(f"[INIT] Created large file download directory: {LARGE_FILE_DOWNLOAD_DIR}")

if not os.path.exists(KATFILE_UPLOAD_DIR):
    os.makedirs(KATFILE_UPLOAD_DIR)
    print(f"[INIT] Created Katfile overflow directory: {KATFILE_UPLOAD_DIR}")

# Load Real-Debrid API token
if REALDEBRID_API_TOKEN:
    print(f"[INIT] Loaded Real-Debrid API token (length: {len(REALDEBRID_API_TOKEN)})")
else:
    print(f"[INIT] Warning: Failed to load Real-Debrid token from .env")

# Load Katfile API token
if KATFILE_API_KEY:
    print(f"[INIT] Loaded Katfile API key (length: {len(KATFILE_API_KEY)})")
else:
    print(f"[INIT] Warning: Failed to load Katfile API key from .env")

if not os.path.exists(DOWNLOAD_DIR):
    try:
        os.makedirs(DOWNLOAD_DIR, exist_ok=True)
        print(f"[INIT] Created download directory: {DOWNLOAD_DIR}")
    except Exception as e:
        print(f"[INIT] Warning: Could not create download directory {DOWNLOAD_DIR}: {e}")

# ==============================================================================

def get_chrome_profile(user_data_dir):
    """
    Clones essential parts of Chrome user data directory to a temporary directory
    to prevent profile locks and allow parallel browser instances.
    """
    import os
    import tempfile
    import shutil
    
    temp_profile_dir = tempfile.mkdtemp(prefix="chrome_profile_cloned_")
    print(f"[INFO] Cloning Chrome profile to temporary directory: {temp_profile_dir}")
    
    # Essential files and subdirectories for extension configuration
    essential_items = [
        "Default/Extensions",
        "Default/Local Extension Settings",
        "Default/Local Storage",
        "Default/Preferences",
        "Default/Network/Cookies",
        "Default/Cookies",
        "Default/Secure Preferences",
        "Default/Extension State",
        "Local State"
    ]
    
    ignore_files = ['Lock', 'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'parent.lock']
    
    for item in essential_items:
        src_path = os.path.join(user_data_dir, item)
        dest_path = os.path.join(temp_profile_dir, item)
        
        if os.path.exists(src_path):
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            try:
                if os.path.isdir(src_path):
                    def ignore_func(path, names):
                        ignored = []
                        for name in names:
                            if name in ignore_files or 'cache' in name.lower() or 'code cache' in name.lower():
                                ignored.append(name)
                        return ignored
                    shutil.copytree(src_path, dest_path, ignore=ignore_func, dirs_exist_ok=True)
                else:
                    shutil.copy2(src_path, dest_path)
            except Exception as e:
                print(f"  [WARN] Failed to copy {item}: {e}")
                
    # Ensure any copied lock files are deleted
    for root, dirs, files in os.walk(temp_profile_dir):
        for name in files:
            if name in ignore_files:
                try:
                    os.remove(os.path.join(root, name))
                except:
                    pass
                    
    def cleanup():
        print(f"[INFO] Cleaning up temporary Chrome profile: {temp_profile_dir}")
        try:
            shutil.rmtree(temp_profile_dir, ignore_errors=True)
        except Exception as e:
            print(f"  [WARN] Failed to delete temporary directory {temp_profile_dir}: {e}")
            
    return temp_profile_dir, cleanup

def resolve_initial_url(url):
    """ Follows URL shorteners to find the underlying URL before processing. """
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
        response = requests.head(url, allow_redirects=True, headers=headers, timeout=10)
        if response.status_code >= 400:
            response = requests.get(url, allow_redirects=True, headers=headers, timeout=10)
        return response.url
    except Exception:
        return url

def bypass_linkvertise_with_api(linkvertise_url, page_idx):
    """ Uses RIP Linkvertise API to bypass and extract rentry.co link - DEPRECATED
    
    NOTE: The RIP Linkvertise API returns HTML with JavaScript that streams the result.
    We can no longer use simple HTTP requests. Must use browser automation instead.
    """
    print(f"   [{page_idx}] [WARN] API bypass method deprecated - requires browser automation")
    return None

def send_notification(title, message, duration=5):
    """Send Windows toast notification (threaded, non-blocking)"""
    try:
        win11toast.notify(
            title,
            message,
            duration=duration,
            icon="assets/logo-redcloud-transparent.png",
            buttons=[{"label": "Open Output Folder", "callback": lambda: os.startfile(OUTPUT_DIR)}] 
        )
    except Exception as e:
        pass  # Silently fail - notifications are optional

def guess_file_extension_from_url(url):
    """Guess file extension from URL content-type or path"""
    common_extensions = {
        'video': ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm'],
        'audio': ['.mp3', '.aac', '.flac', '.wav', '.m4a', '.ogg'],
        'archive': ['.zip', '.rar', '.7z', '.tar', '.gz', '.iso'],
        'document': ['.pdf', '.docx', '.xlsx', '.txt', '.doc', '.ppt'],
        'image': ['.jpg', '.png', '.gif', '.bmp', '.webp', '.svg'],
    }
    
    # Try to extract from URL path
    try:
        from urllib.parse import urlparse
        path = urlparse(url).path.lower()
        
        # Check if any known extension is in the path
        for exts in common_extensions.values():
            for ext in exts:
                if ext in path:
                    return ext
    except:
        pass
    
    return '.bin'  # Default fallback

def generate_safe_filename(url_or_name, prefix="download"):
    """Generate a safe, descriptive filename from URL or name
    
    Falls back to generic name if original cannot be extracted
    """
    import hashlib
    
    try:
        # If it's a URL, try to extract filename
        if url_or_name.startswith('http'):
            from urllib.parse import urlparse, unquote
            parsed = urlparse(url_or_name)
            path = unquote(parsed.path)
            
            # Get filename from path
            filename = path.split('/')[-1]
            if filename and len(filename) > 3:
                return filename
        
        # If it's already a name-like string, use it
        if len(url_or_name) > 5 and '/' not in url_or_name:
            safe_name = re.sub(r'[<>:"/\\|?*]', '_', url_or_name)
            if len(safe_name) > 3:
                return safe_name
    except:
        pass
    
    # Generate generic name with hash suffix for uniqueness
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    url_hash = hashlib.md5(url_or_name.encode()).hexdigest()[:6]
    
    return f"{prefix}_{timestamp}_{url_hash}"

def add_file_extension_to_name(filename, url=""):
    """Ensure filename has proper file extension"""
    
    # If filename already has reasonable extension, keep it
    if '.' in filename:
        ext = filename.split('.')[-1].lower()
        if len(ext) <= 5 and len(ext) >= 2:  # Reasonable extension
            return filename
    
    # Try to guess from URL
    if url:
        guessed_ext = guess_file_extension_from_url(url)
        if guessed_ext and guessed_ext != '.bin':
            return filename + guessed_ext
    
    # Default: add .bin if no extension
    if '.' not in filename:
        return filename + '.bin'
    
    return filename

async def bypass_linkvertise_in_browser(linkvertise_url, browser, page_idx):
    """ Uses TRW and backup REST APIs to extract the rentry/pasterix link. """
    import requests
    import time
    
    encoded_url = quote(linkvertise_url, safe='')
    
    # List of bypass APIs (endpoint, param_name, api_key_param)
    # We will try TRW first, then fallbacks.
    bypass_services = [
        {"endpoint": "https://trw.lat/api/bypass", "url_param": "url", "key_param": "apikey", "key_value": RIP_API_KEY},
        {"endpoint": "https://api.bypass.vip/bypass", "url_param": "url", "key_param": "key", "key_value": ""},
        {"endpoint": "https://free.bypass-api.com/bypass", "url_param": "url", "key_param": "apikey", "key_value": ""}
    ]
    
    for service in bypass_services:
        endpoint = service["endpoint"]
        url_param = service["url_param"]
        key_param = service["key_param"]
        key_value = service["key_value"]
        
        print(f"   [{page_idx}] Requesting Linkvertise bypass via {endpoint}...")
        
        # Build query params
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
                    # TRW format or generic format
                    if data.get('success'):
                        res_link = data.get('result') or data.get('destination')
                    # Handle other potential JSON keys
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
                            break  # Try next service
                    
                    print(f"   [{page_idx}] [FAIL] Service response failed validation: {data}")
                    break  # Try next service
                    
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
                    break  # Try next service
                else:
                    print(f"   [{page_idx}] [FAIL] Unknown status: {resp.status_code}")
                    break  # Try next service
                    
            except Exception as e:
                print(f"   [{page_idx}] [FAIL] Request to {endpoint} error: {str(e)[:100]}")
                break  # Try next service
                
    print(f"   [{page_idx}] ✗ All Linkvertise bypass services failed.")
    return None

async def expand_mega_folder(mega_folder_url, browser=None):
    """
    Expand MEGA folder link to individual file links
    Args:
        mega_folder_url: MEGA folder link (e.g., mega.nz/folder/...)
        browser: Optional browser instance for extraction
    Returns:
        List of individual file links from the folder
    """
    print(f"   Expanding MEGA folder: {mega_folder_url}...")
    
    try:
        # Method 1: Try using MEGA SDK via requests
        # This attempts to get folder metadata from MEGA's API
        # Note: MEGA may block this or require authentication
        
        # Extract folder ID and key from URL
        import re
        match = re.search(r'mega.nz/folder/([^#]+)#([\w-]+)', mega_folder_url)
        if not match:
            print(f"   ⚠️  Could not parse MEGA folder URL")
            return []
        
        folder_id, folder_key = match.groups()
        print(f"   Folder ID: {folder_id}")
        print(f"   Trying MEGA API to expand folder...")
        
        # Make request to MEGA API for folder contents
        # Note: This may fail if MEGA blocks API access or folder is private
        try:
            api_response = requests.post(
                'https://g.api.mega.co.nz/cs',
                json=[{'a': 'f', 'c': 1, 'r': 1, 'ca': [folder_id + ':' + folder_key]}],
                timeout=10
            )
            
            if api_response.status_code == 200:
                data = api_response.json()
                print(f"   ✓ MEGA API responded")
                # TODO: Parse MEGA API response to extract files
                # This requires understanding MEGA's response format
                # For now, we'll skip this and use browser-based method
        except:
            pass
        
        # Method 2: Use browser to navigate and extract file links
        if browser:
            print(f"   Using browser to extract files from folder...")
            import asyncio
            try:
                # This would need to be async, implemented separately
                print(f"   ⚠️  Browser-based folder expansion not yet implemented")
            except:
                pass
        
        # Fallback: Return the folder link itself
        # Real-Debrid will fail on it, but user can manually expand
        print(f"   ⚠️  Unable to expand folder automatically")
        print(f"   Option 1: Download MEGA folder manually and extract files")
        print(f"   Option 2: Get individual file links from folder page via browser")
        print(f"   Option 3: Use MEGA app/client to see individual files")
        
        return [mega_folder_url]  # Return original as fallback
    
    except Exception as e:
        print(f"   ✗ Expansion failed: {str(e)}")
        return [mega_folder_url]

async def extract_mega_from_rentry(rentry_url, browser, page_idx):
    """ Opens rentry.co link in Mullvad browser and extracts mega.nz link """
    page = None
    try:
        print(f"   [{page_idx}] Opening rentry.co link in browser (8s timeout)...")
        page = await browser.new_page()
        
        await page.goto(rentry_url, wait_until="domcontentloaded", timeout=8000)
        print(f"   [{page_idx}] Page loaded, extracting mega link...")
        await asyncio.sleep(1)
        
        # Extract mega link from page
        mega_link = await page.evaluate(r"""
            () => {
                // Look for mega.nz link anywhere on the page
                const links = Array.from(document.querySelectorAll('a'));
                for (let link of links) {
                    if (link.href && link.href.includes('mega.nz')) {
                        return link.href;
                    }
                }
                
                // Also search in text content
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
            
            # Try again after wait
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
            
            # Take screenshot for debugging
            debug_screenshot = os.path.join(ARTIFACTS_DIR, f"debug_rentry_page_{page_idx}.png")
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

def unrestrict_mega_with_realdebrid(mega_url, item_idx):
    """ Uses Real-Debrid API to unrestrict a MEGA link and get direct download URL """
    if not REALDEBRID_API_TOKEN:
        print(f"   [{item_idx}] ✗ Real-Debrid API token not loaded")
        return None
    
    try:
        print(f"   [{item_idx}] Unrestricting MEGA link with Real-Debrid API...")
        
        headers = {
            'Authorization': f'Bearer {REALDEBRID_API_TOKEN}',
            'User-Agent': 'Mozilla/5.0'
        }
        
        payload = {
            'link': mega_url
        }
        
        response = requests.post(
            f"{REALDEBRID_API_BASE}/unrestrict/link",
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

def upload_to_katfile(download_url, filename, item_idx):
    """ Streams file directly from Real-Debrid download URL to Katfile using 3-step API """
    if not KATFILE_API_KEY:
        print(f"   [{item_idx}] ✗ Katfile API key not loaded")
        return None
    
    try:
        print(f"   [{item_idx}] Uploading to Katfile: {filename}")
        
        # STEP 1: Get upload server and session ID
        print(f"   [{item_idx}] Step 1/3: Getting upload server...")
        server_response = requests.get(
            KATFILE_UPLOAD_SERVER_ENDPOINT,
            params={'key': KATFILE_API_KEY},
            timeout=10
        )
        
        if server_response.status_code != 200:
            print(f"   [{item_idx}] ✗ Failed to get upload server: {server_response.status_code}")
            print(f"   [{item_idx}]   Response: {server_response.text[:200]}")
            return None
        
        try:
            server_data = server_response.json()
            upload_url = server_data.get('result')
            sess_id = server_data.get('sess_id')
            
            if not upload_url or not sess_id:
                print(f"   [{item_idx}] ✗ Invalid upload server response: {server_data}")
                return None
                
            print(f"   [{item_idx}] ✓ Got upload server: {upload_url}")
            print(f"   [{item_idx}] ✓ Session ID: {sess_id}")
        except:
            print(f"   [{item_idx}] ✗ Failed to parse server response: {server_response.text[:200]}")
            return None
        
        # STEP 2: Upload file to the server
        print(f"   [{item_idx}] Step 2/3: Uploading file to server...")
        print(f"   [{item_idx}] Streaming from Real-Debrid...")
        
        with requests.get(download_url, stream=True, timeout=600) as rd_response:
            if rd_response.status_code != 200:
                print(f"   [{item_idx}] ✗ Failed to access Real-Debrid download URL: {rd_response.status_code}")
                return None
            
            files = {
                'file_0': (filename, rd_response.raw, 'application/octet-stream')
            }
            
            data = {
                'sess_id': sess_id,
                'utype': 'prem'
            }
            
            upload_response = requests.post(
                upload_url,
                files=files,
                data=data,
                timeout=600
            )
            
            if upload_response.status_code != 200:
                print(f"   [{item_idx}] ✗ Upload failed: {upload_response.status_code}")
                print(f"   [{item_idx}]   Response: {upload_response.text[:200]}")
                return None
            
            try:
                upload_result = upload_response.json()
                
                # Response is an array like [{"file_code":"yzanp0ps7sgl","file_status":"OK"}]
                if isinstance(upload_result, list) and len(upload_result) > 0:
                    file_data = upload_result[0]
                    file_code = file_data.get('file_code')
                    file_status = file_data.get('file_status')
                    
                    if file_status != 'OK' or not file_code:
                        print(f"   [{item_idx}] ✗ Upload status: {file_status}")
                        return None
                    
                    print(f"   [{item_idx}] ✓ Upload successful")
                    print(f"   [{item_idx}] File code: {file_code}")
                else:
                    print(f"   [{item_idx}] ✗ Invalid upload response: {upload_result}")
                    return None
            except Exception as e:
                print(f"   [{item_idx}] ✗ Failed to parse upload response: {str(e)}")
                print(f"   [{item_idx}]   Response: {upload_response.text[:200]}")
                return None
        
        # STEP 3: Construct final URL
        print(f"   [{item_idx}] Step 3/3: Constructing final URL...")
        katfile_url = f"{KATFILE_DOMAIN}/{file_code}"
        
        print(f"   [{item_idx}] ✓ File uploaded to Katfile")
        print(f"   [{item_idx}]   URL: {katfile_url}")
        
        return {
            'katfile_url': katfile_url,
            'file_code': file_code,
            'filename': filename
        }
    
    except requests.exceptions.Timeout:
        print(f"   [{item_idx}] ✗ Request timeout")
        return None
    except Exception as e:
        print(f"   [{item_idx}] ✗ Katfile upload error: {str(e)}")
        import traceback
        traceback.print_exc()
        return None

def upload_local_file_to_katfile(local_file_path, item_idx):
    """ Uploads a local file from disk to Katfile using the 3-step API """
    if not KATFILE_API_KEY:
        print(f"   [Katfile Local] ✗ API key not loaded")
        return None
    
    filename = os.path.basename(local_file_path)
    file_size = os.path.getsize(local_file_path)
    
    try:
        print(f"   [Katfile Local] [{item_idx}] Uploading: {filename} ({file_size / (1024**2):.2f} MB)...")
        
        # STEP 1: Get upload server
        server_response = requests.get(
            KATFILE_UPLOAD_SERVER_ENDPOINT,
            params={'key': KATFILE_API_KEY},
            timeout=10
        )
        
        if server_response.status_code != 200:
            print(f"   [Katfile Local] [{item_idx}] ✗ Failed to get server: {server_response.status_code}")
            return None
            
        server_data = server_response.json()
        upload_url = server_data.get('result')
        sess_id = server_data.get('sess_id')
        
        if not upload_url or not sess_id:
            print(f"   [Katfile Local] [{item_idx}] ✗ Invalid server response")
            return None
            
        # STEP 2: Post the local file
        with open(local_file_path, 'rb') as f:
            files = {
                'file_0': (filename, f, 'application/octet-stream')
            }
            data = {
                'sess_id': sess_id,
                'utype': 'prem'
            }
            
            upload_response = requests.post(
                upload_url,
                files=files,
                data=data,
                timeout=1200  # Give it 20 minutes for large uploads
            )
            
        if upload_response.status_code != 200:
            print(f"   [Katfile Local] [{item_idx}] [FAIL] Upload failed: {upload_response.status_code}")
            return None
            
        upload_result = upload_response.json()
        if isinstance(upload_result, list) and len(upload_result) > 0:
            file_data = upload_result[0]
            file_code = file_data.get('file_code')
            file_status = file_data.get('file_status')
            
            if file_status != 'OK' or not file_code:
                print(f"   [Katfile Local] [{item_idx}] [FAIL] Upload status: {file_status}")
                return None
                
            katfile_url = f"{KATFILE_DOMAIN}/{file_code}"
            print(f"   [Katfile Local] [{item_idx}] [OK] Uploaded: {katfile_url}")
            
            # Register in Link Sharing
            register_mirror_in_link_sharing(filename, katfile_url)
            
            # Log the upload to keep track of daily size
            log_file = os.path.join(OUTPUT_DIR, "uploads_log.txt")
            today = datetime.date.today().isoformat()
            with open(log_file, 'a', encoding='utf-8') as lf:
                lf.write(f"[{today}] {filename} ({file_size / (1024**3):.4f} GB) -> katfile (local)\n")
                
            return {
                'katfile_url': katfile_url,
                'file_code': file_code,
                'filename': filename
            }
        return None
    except Exception as e:
        print(f"   [Katfile Local] [{item_idx}] [FAIL] Upload error: {e}")
        return None

async def background_katfile_uploader():
    """
    Scans DOWNLOAD_DIR for files and uploads them to Katfile in parallel (up to 3 concurrent uploads)
    at random until the daily Katfile upload limit is reached. Keeps files on disk and logs a warning on completion/limit.
    """
    import glob
    import random
    
    upload_dir = DOWNLOAD_DIR
    if not os.path.exists(upload_dir):
        print(f"[BG Uploader] Directory {upload_dir} does not exist. Uploader skipped.")
        return
        
    print(f"[BG Uploader] Starting background uploader for {upload_dir}...")
    
    # Get all files in DOWNLOAD_DIR
    files = [f for f in glob.glob(os.path.join(upload_dir, "*")) if os.path.isfile(f)]
    if not files:
        print(f"[BG Uploader] No files found in {upload_dir}.")
        return
        
    # Shuffle files to pick at random
    random.shuffle(files)
    
    # Track concurrent uploads
    active_uploads = []
    max_concurrent_uploads = 3
    
    for idx, file_path in enumerate(files, 1):
        file_size = os.path.getsize(file_path)
        
        # Check if we can upload without exceeding limit
        uploaded_today = get_katfile_daily_uploaded_size()
        if uploaded_today + file_size > KATFILE_DAILY_LIMIT:
            print(f"[BG Uploader] [WARN] Limit reached or file {os.path.basename(file_path)} would exceed daily Katfile limit of {KATFILE_DAILY_LIMIT / (1024**3):.2f} GB. Stopping background uploads.")
            break
            
        # Wait if we hit max concurrent limit
        while len(active_uploads) >= max_concurrent_uploads:
            # Clean up finished tasks
            active_uploads = [t for t in active_uploads if not t.done()]
            await asyncio.sleep(1)
            
        print(f"[BG Uploader] Scheduling upload: {os.path.basename(file_path)}")
        # Start upload in background thread/task
        task = asyncio.get_running_loop().run_in_executor(
            None,
            upload_local_file_to_katfile,
            file_path,
            idx
        )
        active_uploads.append(task)
        # Add slight delay between starting uploads
        await asyncio.sleep(2)
        
    # Wait for remaining uploads to complete
    if active_uploads:
        print(f"[BG Uploader] Waiting for remaining background uploads to finish...")
        await asyncio.gather(*active_uploads, return_exceptions=True)
    print(f"[BG Uploader] [WARN] Background uploader finished. Keeping uploaded files in {upload_dir}.")

def slugify(text):
    text = text.lower()
    # Remove extension if present
    if '.' in text:
        text = '.'.join(text.split('.')[:-1])
    # Replace non-alphanumeric with hyphens
    text = re.sub(r'[^a-z0-9_-]+', '-', text)
    # Remove multiple consecutive hyphens
    text = re.sub(r'-+', '-', text)
    # Strip hyphens from ends
    return text.strip('-')[:100]

def register_mirror_in_link_sharing(filename, remote_url):
    """
    Registers a file and its mirror link in the local Prom King Link Sharing service.
    """
    import requests
    import re
    import uuid
    from urllib.parse import urlparse
    
    API_BASE_URL = "http://100.67.25.118:9001"
    API_KEY = "dev-secret-key-123" # Must match .env config
    
    headers = {
        "Authorization": f"Bearer {API_KEY}"
    }
    
    try:
        # 1. Fetch hosts from Link Sharing API
        hosts_resp = requests.get(f"{API_BASE_URL}/api/hosts", headers=headers, timeout=5)
        if hosts_resp.status_code != 200:
            print(f"[Link Sharing] Failed to fetch hosts: {hosts_resp.status_code} {hosts_resp.text}")
            return None
            
        hosts = hosts_resp.json()
        
        # 2. Determine which host matches the remote_url
        domain = urlparse(remote_url).hostname
        if not domain:
            print(f"[Link Sharing] Invalid mirror URL: {remote_url}")
            return None
        domain = domain.lower().replace("www.", "")
        
        host_id = None
        for host in hosts:
            base_domain = host.get("baseDomain", "").lower()
            # Simple check if host domain is inside our mirror domain or vice versa
            if base_domain in domain or domain in base_domain:
                host_id = host["id"]
                break
                
        # Keyword fallback matching if not found by exact/substring domain match
        if not host_id:
            keywords_mapping = {
                "katfile": ["katfile"],
                "keep2share": ["k2s", "keep2share"],
                "fileboom": ["fileboom", "fboom"],
                "rapidgator": ["rapidgator", "rg.to"]
            }
            for host in hosts:
                host_name_lower = host.get("name", "").lower()
                base_domain = host.get("baseDomain", "").lower()
                for key, kw_list in keywords_mapping.items():
                    if any(kw in domain for kw in kw_list):
                        if any(kw in host_name_lower or kw in base_domain for kw in kw_list):
                            host_id = host["id"]
                            break
                if host_id:
                    break
                    
        if not host_id:
            print(f"[Link Sharing] No matching host found in DB for domain: {domain}")
            return None
            
        # 3. Create a clean, unique slug
        slug = slugify(filename)
        # Add a short random suffix to make it completely unique and avoid slug conflicts
        slug = f"{slug}-{uuid.uuid4().hex[:6]}"
        
        # 4. Call quick-create endpoint
        payload = {
            "title": filename,
            "contentId": f"vid-{hash(filename) & 0xffffffff}",
            "slug": slug,
            "hostId": host_id,
            "remoteUrl": remote_url,
            "priority": 100
        }
        
        create_resp = requests.post(
            f"{API_BASE_URL}/api/routes/quick-create",
            headers=headers,
            json=payload,
            timeout=5
        )
        
        if create_resp.status_code in [200, 201]:
            result = create_resp.json()
            print(f"[Link Sharing] [OK] Registered mirror on {domain} -> {API_BASE_URL}/f/{result['slug']}")
            return result
        else:
            print(f"[Link Sharing] Failed to quick-create route: {create_resp.status_code} {create_resp.text}")
            return None
            
    except Exception as e:
        print(f"[Link Sharing] [ERROR] Exception registering mirror: {e}")
        return None

async def background_dual_uploader():
    if not is_token_valid():
        print("[BG Dual Uploader] ✗ Keep2Share/FileBoom token is invalid or expired. Skipping background uploader.")
        return

    """
    Scans G:\\mega for files and uploads them to FileBoom/Keep2Share in parallel (up to 3 concurrent uploads)
    at random. Appends links to output/uploads_log.txt and logs progress.
    """
    import glob
    import random
    
    upload_dir = r"G:\mega"
    if not os.path.exists(upload_dir):
        print(f"[BG Dual Uploader] Directory {upload_dir} does not exist. Uploader skipped.")
        return
        
    print(f"[BG Dual Uploader] Starting background dual uploader for {upload_dir}...")
    
    # Get all files in G:\mega
    all_files = [f for f in glob.glob(os.path.join(upload_dir, "*")) if os.path.isfile(f)]
    # Filter out helper files/incomplete downloads
    files = []
    for f in all_files:
        name = os.path.basename(f)
        if name.startswith('.') or name.endswith('.incomplete') or name.endswith('.trickplay') or name.endswith('.torrents'):
            continue
        files.append(f)
        
    if not files:
        print(f"[BG Dual Uploader] No valid upload candidates found in {upload_dir}.")
        return
        
    # Shuffle to pick at random
    random.shuffle(files)
    
    # Track concurrent uploads
    active_uploads = []
    max_concurrent_uploads = 3
    
    # Define a helper wrapper for running synchronous upload_file_dual in run_in_executor
    def run_upload(file_path):
        filename = os.path.basename(file_path)
        file_size = os.path.getsize(file_path)
        try:
            res = upload_file_dual(file_path)
            if res and res.get("link"):
                # Append to uploads_log.txt in the same format
                log_path = os.path.join(OUTPUT_DIR, "uploads_log.txt")
                now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                size_gb = file_size / (1024**3)
                log_line = f"[{now_str}] {filename} ({size_gb:.2f} GB) → {res['service']}"
                if res.get('instant'):
                    log_line += " (INSTANT)"
                log_line += f" | Link: {res['link']}\n"
                
                with open(log_path, 'a', encoding='utf-8') as lf:
                    lf.write(log_line)
                print(f"[BG Dual Uploader] [OK] [{res['service']}] Uploaded {filename} -> {res['link']}")
                
                # Register in Link Sharing
                register_mirror_in_link_sharing(filename, res['link'])
                return True
            else:
                print(f"[BG Dual Uploader] [FAIL] Failed to upload {filename}")
                return False
        except Exception as e:
            print(f"[BG Dual Uploader] [FAIL] Exception uploading {filename}: {e}")
            return False
            
    for idx, file_path in enumerate(files, 1):
        # Wait if we hit max concurrent limit
        while len(active_uploads) >= max_concurrent_uploads:
            # Clean up finished tasks
            active_uploads = [t for t in active_uploads if not t.done()]
            await asyncio.sleep(1)
            
        print(f"[BG Dual Uploader] Scheduling dual upload: {os.path.basename(file_path)}")
        # Start upload in background thread/task
        task = asyncio.get_running_loop().run_in_executor(
            None,
            run_upload,
            file_path
        )
        active_uploads.append(task)
        # Add slight delay between starting uploads
        await asyncio.sleep(2)
        
    # Wait for remaining uploads to complete
    if active_uploads:
        print(f"[BG Dual Uploader] Waiting for remaining background dual uploads to finish...")
        await asyncio.gather(*active_uploads, return_exceptions=True)
    print(f"[BG Dual Uploader] [WARN] Background dual uploader finished. Keeping uploaded files in {upload_dir}.")

def get_google_drive_service():
    """Authenticate with Google Drive using OAuth2 or Service Account"""    
    try:
        # Path: telegram/ -> python-scripts/ -> Github Repos/ -> .access/
        access_dir = os.path.join(os.path.dirname(os.path.dirname(SCRIPT_DIR)), ".access")
        
        # Try service account first (better for automation)
        service_account_files = [
            os.path.join(access_dir, "service-account.json"),
            os.path.join(access_dir, "gdrive-service-account.json"),
        ]
        
        for service_file in service_account_files:
            if os.path.exists(service_file):
                try:
                    from google.oauth2.service_account import Credentials
                    creds = Credentials.from_service_account_file(
                        service_file,
                        scopes=['https://www.googleapis.com/auth/drive']
                    )
                    service = build('drive', 'v3', credentials=creds)
                    print(f"[OK] Google Drive authenticated via Service Account")
                    return service
                except Exception as e:
                    print(f"[WARN] Service account auth failed: {e}")
        
        # Fallback to OAuth2 (mega-to-gdrive-oauth.json or client_secret*.json)
        import glob
        oauth_file = None
        
        # First try the new desktop app credentials (in root .access)
        new_oauth = os.path.join(access_dir, "mega-to-gdrive-oauth.json")
        if os.path.exists(new_oauth):
            oauth_file = new_oauth
            print(f"[OAUTH2] Using: {new_oauth}")
        else:
            # Fall back to old pattern
            oauth_pattern = os.path.join(access_dir, "*client_secret*.json")
            oauth_files = glob.glob(oauth_pattern)
            if oauth_files:
                oauth_file = oauth_files[0]
                print(f"[OAUTH2] Using: {oauth_file}")
        
        if oauth_file:
            try:
                from google_auth_oauthlib.flow import InstalledAppFlow
                from google.auth.transport.requests import Request
                from google.oauth2.credentials import Credentials as OAuthCredentials
                
                token_file = os.path.join(SCRIPT_DIR, ".gdrive_token.json")
                creds = None
                
                # Load existing token if available
                if os.path.exists(token_file):
                    creds = OAuthCredentials.from_authorized_user_file(token_file)
                    if creds.expired and creds.refresh_token:
                        creds.refresh(Request())
                
                # Request new auth if needed
                if not creds or not creds.valid:
                    flow = InstalledAppFlow.from_client_secrets_file(
                        oauth_file,
                        scopes=['https://www.googleapis.com/auth/drive']
                    )
                    
                    # Check what redirect_uri is in the client_secrets
                    # The code will use the redirect_uri registered in Google Cloud Console
                    print(f"\n[OAUTH2] Starting authorization flow...")
                    print(f"[OAUTH2] Reading redirect_uri from client_secrets.json...")
                    
                    import json
                    with open(oauth_file, 'r') as f:
                        secrets = json.load(f)
                        client_config = secrets.get('installed', {})
                        redirect_uris = client_config.get('redirect_uris', [])
                    
                    print(f"[OAUTH2] Registered redirect_uri(s):")
                    for uri in redirect_uris:
                        print(f"         {uri}")
                    
                    # Determine which method to use
                    auth_success = False
                    
                    # Try out-of-band flow (manual code entry) - works without local server
                    try:
                        print(f"\n[OAUTH2] Using out-of-band flow (manual code entry)...")
                        creds = flow.run_local_server(port=8888, open_browser=True, timeout_seconds=120)
                        auth_success = True
                    except Exception as e:
                        print(f"[OAUTH2] Local server failed: {str(e)[:100]}")
                        
                        # Fallback to manual browser flow
                        try:
                            print(f"\n[OAUTH2] Falling back to manual browser entry...")
                            
                            # Generate auth URL without local server
                            auth_url, state = flow.authorization_url()
                            
                            print(f"\n[STEP 1] Copy and visit this URL in your browser:")
                            print("")
                            print(f"    {auth_url}")
                            print("")
                            print(f"[STEP 2] Follow the prompts and sign in")
                            print(f"[STEP 3] You will be redirected to localhost (even if it fails)")
                            print(f"[STEP 4] Copy the authorization code from the URL")
                            print(f"        (look for: ...&code=XXXXXXX&... in the address bar)")
                            print("")
                            
                            auth_code = input("Enter the authorization code: ").strip()
                            
                            if auth_code:
                                creds = flow.fetch_token(code=auth_code)
                                auth_success = True
                                print(f"[OAUTH2] ✓ Authorization successful")
                            else:
                                print(f"[OAUTH2] ✗ No code provided")
                        except Exception as e2:
                            print(f"[OAUTH2] Manual flow failed: {str(e2)[:100]}")
                    
                    # Save token for future use
                    if creds and auth_success:
                        with open(token_file, 'w') as f:
                            import json
                            # Handle both oauth2.credentials.Credentials and dict returns
                            if hasattr(creds, 'to_json'):
                                json.dump(json.loads(creds.to_json()), f)
                            else:
                                json.dump(creds, f)
                        print(f"[OAUTH2] Token saved: {token_file}")
                    elif not auth_success:
                        print(f"[OAUTH2] ✗ Authorization failed")
                        return None
                
                service = build('drive', 'v3', credentials=creds)
                print(f"[OK] Google Drive authenticated via OAuth2")
                return service
                
            except Exception as e:
                print(f"[WARN] OAuth2 auth failed: {e}")
        
        print("[WARN] No Google Drive credentials found (no service account or OAuth2 file)")
        return None
        
    except Exception as e:
        print(f"[WARN] Error loading Google Drive service: {e}")
        import traceback
        traceback.print_exc()
        return None

def upload_to_google_drive(file_path, filename, drive_service, item_idx, original_url=""):
    """Upload file to Google Drive with improved naming"""
    if not drive_service:
        return None
    
    try:
        # Generate better filename if needed
        if not filename or filename.startswith('download_'):
            better_name = generate_safe_filename(original_url, prefix="content")
            filename = better_name
        
        # Ensure proper file extension
        filename = add_file_extension_to_name(filename, original_url)
        
        print(f"   [{item_idx}] Uploading to Google Drive: {filename}")
        
        from googleapiclient.http import MediaFileUpload
        
        file_metadata = {'name': filename}
        media = MediaFileUpload(file_path, resumable=True)
        
        file = drive_service.files().create(
            body=file_metadata,
            media_body=media,
            fields='id, webViewLink, name'
        ).execute()
        
        drive_url = file.get('webViewLink')
        print(f"   [{item_idx}] [OK] Uploaded to Google Drive")
        print(f"   [{item_idx}]   URL: {drive_url}")
        
        return {
            'drive_url': drive_url,
            'file_id': file.get('id'),
            'filename': filename
        }
    except Exception as e:
        print(f"   [{item_idx}] [FAIL] Google Drive upload error: {e}")
        return None

async def download_file_with_browser(download_url, filename, browser, item_idx):
    """ Downloads file from unrestricted URL using browser (in headless mode) """
    try:
        print(f"   [{item_idx}] Downloading: {filename}")
        
        page = await browser.new_page()
        
        # Set download handler and navigate
        # For direct download URLs, expect_download() will catch the download
        # even if goto() fails or times out
        download = None
        async with page.expect_download() as dl_promise:
            try:
                # Try navigating - for direct downloads, this may fail or timeout
                # but expect_download() will still catch the actual download event
                await page.goto(download_url, timeout=15000)
            except Exception as nav_error:
                # Expected for direct download URLs
                # Just proceed - the download is still being captured by expect_download()
                pass
            
            # Wait for download to complete (will wait up to the page timeout)
            try:
                download = await asyncio.wait_for(dl_promise.value, timeout=30.0)
            except asyncio.TimeoutError:
                raise Exception("Download did not start within 30 seconds")
        
        # Save to downloads directory
        output_path = os.path.join(DOWNLOAD_DIR, filename)
        await download.save_as(output_path)
        
        file_size = os.path.getsize(output_path)
        print(f"   [{item_idx}] ✓ Downloaded: {filename} ({file_size / (1024**3):.2f} GB)")
        
        await page.close()
        return output_path
        
    except asyncio.TimeoutError:
        print(f"   [{item_idx}] ✗ Download timeout")
        return None
    except Exception as e:
        print(f"   [{item_idx}] ✗ Download failed: {str(e)[:80]}")
        return None

# ==============================================================================
# CAPTCHA SOLVING CODE (ARCHIVED - Not currently used, kept for reference)
# ==============================================================================

async def solve_specific_captcha(page, page_idx):
    """ Solves RGS CAPTCHA by finding and dragging DRAG/DROP targets """
    try:
        print(f"   [{page_idx}] ========== SOLVING RGS CAPTCHA ==========")
        
        # Take initial screenshot
        debug_initial = os.path.join(ARTIFACTS_DIR, f"debug_captcha_initial_{page_idx}.png")
        await page.screenshot(path=debug_initial)
        print(f"   [{page_idx}] Initial state: {debug_initial}")
        
        # Allow page to render
        await page.wait_for_timeout(2000)
        
        # Step 1: Find and click the "Start" button inside shadowRoot
        print(f"   [{page_idx}] Looking for 'Start' button inside shadowRoot...")
        start_btn = await page.evaluate("""
            () => {
                // Search for rgs element
                let container = document.querySelectorAll("[id*=rgs]");
                
                if (container.length === 0) {
                    return { found: false, error: 'No rgs element found' };
                }
                
                // Iterate through rgs containers
                for (let elem of container) {
                    if (!elem.shadowRoot) continue;
                    
                    // Look for buttons in shadowRoot
                    let buttons = elem.shadowRoot.querySelectorAll('button');
                    
                    for (let btn of buttons) {
                        if (btn.innerText && btn.innerText.trim() === 'Start') {
                            const rect = btn.getBoundingClientRect();
                            return {
                                x: rect.x + (rect.width / 2),
                                y: rect.y + (rect.height / 2),
                                found: true,
                                buttonText: btn.innerText.trim()
                            };
                        }
                    }
                }
                
                return { found: false, error: 'Start button not found in shadowRoot' };
            }
        """)
        
        if not start_btn.get('found'):
            print(f"   [{page_idx}] ⚠️  'Start' button not found in shadowRoot")
            print(f"   [{page_idx}] Error: {start_btn.get('error', 'Unknown error')}")
            return False
        
        print(f"   [{page_idx}] ✓ Found 'Start' button at ({start_btn['x']:.0f}, {start_btn['y']:.0f})")
        print(f"   [{page_idx}] Clicking 'Start' button...")
        await page.mouse.click(start_btn['x'], start_btn['y'])
        print(f"   [{page_idx}] ✓ 'Start' button clicked")
        
        # Wait for CAPTCHA to initialize after clicking Start
        await page.wait_for_timeout(2000)
        
        # Take screenshot after Start click
        debug_after_start = os.path.join(ARTIFACTS_DIR, f"debug_captcha_after_start_{page_idx}.png")
        await page.screenshot(path=debug_after_start)
        print(f"   [{page_idx}] After Start click: {debug_after_start}")
        
        # Find RGS element and navigate to DRAG/DROP targets
        print(f"   [{page_idx}] Looking for RGS CAPTCHA structure...")
        targets = await page.evaluate("""
            () => {
                const rgsElem = document.querySelector('[id^="rgs-"]');
                if (!rgsElem) return { error: 'No rgs element' };
                if (!rgsElem.shadowRoot) return { error: 'No shadowRoot' };
                
                let node = rgsElem.shadowRoot;
                
                // shadowRoot -> child[0] -> child[0] -> child[2]
                if (node.childNodes.length < 1) return { error: 'shadowRoot has no children' };
                node = node.childNodes[0];
                
                if (!node.childNodes || node.childNodes.length < 1) return { error: 'First child has no children' };
                node = node.childNodes[0];
                
                if (!node.childNodes || node.childNodes.length < 3) return { error: `Second child has ${node.childNodes?.length || 0} children` };
                const container = node.childNodes[2];
                
                if (!container.childNodes || container.childNodes.length < 2) return { error: `Container has ${container.childNodes?.length || 0} children` };
                
                const dropTarget = container.childNodes[0];
                const dragTarget = container.childNodes[1];
                
                const dropRect = dropTarget.getBoundingClientRect();
                const dragRect = dragTarget.getBoundingClientRect();
                
                return {
                    drop: { x: dropRect.x + (dropRect.width / 2), y: dropRect.y + (dropRect.height / 2), width: dropRect.width, height: dropRect.height },
                    drag: { x: dragRect.x + (dragRect.width / 2), y: dragRect.y + (dragRect.height / 2), width: dragRect.width, height: dragRect.height }
                };
            }
        """)
        
        if 'error' in targets:
            print(f"   [{page_idx}] ⚠️  Navigation failed: {targets['error']}")
            debug_diag = os.path.join(ARTIFACTS_DIR, f"debug_structure_issue_{page_idx}.png")
            await page.screenshot(path=debug_diag)
            print(f"   [{page_idx}] Page state: {debug_diag}")
            return False
        
        print(f"   [{page_idx}] ✓ DROP TARGET at ({targets['drop']['x']:.0f}, {targets['drop']['y']:.0f})")
        print(f"   [{page_idx}] ✓ DRAG TARGET at ({targets['drag']['x']:.0f}, {targets['drag']['y']:.0f})")
        
        # Screenshot before drag
        debug_before = os.path.join(ARTIFACTS_DIR, f"debug_rgs_before_{page_idx}.png")
        await page.screenshot(path=debug_before)
        print(f"   [{page_idx}] Before drag: {debug_before}")
        
        # Perform drag operation
        start_x = targets['drag']['x']
        start_y = targets['drag']['y']
        end_x = targets['drop']['x']
        end_y = targets['drop']['y']
        
        print(f"   [{page_idx}] Dragging from ({start_x:.0f}, {start_y:.0f}) → ({end_x:.0f}, {end_y:.0f})")
        
        await page.mouse.move(start_x, start_y)
        await page.mouse.down()
        
        # Smooth drag over 3.5 seconds
        num_steps = 35
        for step in range(num_steps):
            progress = step / (num_steps - 1) if num_steps > 1 else 1.0
            current_x = start_x + (end_x - start_x) * progress
            current_y = start_y + (end_y - start_y) * progress
            await page.mouse.move(current_x, current_y)
            await page.wait_for_timeout(100)
        
        await page.mouse.up()
        print(f"   [{page_idx}] ✓ Drag completed!")
        
        # Screenshot after drag
        await page.wait_for_timeout(1000)
        debug_after = os.path.join(ARTIFACTS_DIR, f"debug_rgs_after_{page_idx}.png")
        await page.screenshot(path=debug_after)
        print(f"   [{page_idx}] After drag: {debug_after}")
        
        print(f"   [{page_idx}] ========== RGS CAPTCHA SOLVED ==========")
        input(f"   [{page_idx}] Press ENTER after analyzing...")
        
        return True
        
    except Exception as e:
        print(f"   [{page_idx}] RGS CAPTCHA solve failed: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

async def resolve_url_with_browser(url, context, page_idx):
    """ Clicks CTA via headless browser, handles the new tab, and extracts the first mega.nz target."""
    page = None
    try:
        page = await context.new_page()
        # Apply stealth maneuvers to evade bot detection
        await Stealth().apply_stealth_async(page)
        
        print(f"   [{page_idx}] Navigating to webpage...")
        # Navigate and wait for JS to load
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        
        # Reset zoom and DPI to 100% to fix layout issues
        await page.evaluate("""
            () => {
                document.body.style.zoom = '100%';
                window.devicePixelRatio = 1.0;
            }
        """)
        
        # Add extra rendering time and human-like delay
        delay = random.uniform(2.5, 4.5)
        print(f"   [{page_idx}] Page loaded. Allowing {delay:.2f}s for full render and human simulation...")
        await asyncio.sleep(delay)
        
        # Click the #cta-button if it exists to unravel the endpoint
        try:
            print(f"   [{page_idx}] Looking for #cta-button...")
            btn = await page.wait_for_selector('#cta-button', timeout=8000)
            
            if btn:
                # Hover over the button randomly before clicking
                print(f"   [{page_idx}] Hovering over #cta-button...")
                await btn.hover()
                await asyncio.sleep(random.uniform(0.5, 1.5))
                
                debug_before = os.path.join(ARTIFACTS_DIR, f"debug_before_click_{page_idx}.png")
                await page.screenshot(path=debug_before)
                print(f"   [{page_idx}] Captured screenshot before click at {debug_before}")
                
                print(f"   [{page_idx}] Emulating click on #cta-button...")
                # The button opens a new tab. We must intercept the new page logic.
                async with context.expect_page(timeout=15000) as new_page_info:
                    await btn.click(delay=random.randint(50, 200), force=True) # Human click hold duration, force click if overlaid
                
                print(f"   [{page_idx}] Intercepted popup! Waiting for it to stabilize...")
                popup = await new_page_info.value
                await popup.wait_for_load_state("domcontentloaded")
                await asyncio.sleep(3)  # Extended wait time
                
                # PAUSE FOR MEGA LINK INSPECTION
                print(f"   [{page_idx}] Popup opened! Pausing for {popup.url}...")
                print(f"   [{page_idx}] ========== INSPECT POPUP FOR MEGA LINK ==========")
                print(f"   [{page_idx}] Current popup URL: {popup.url}")
                print(f"   [{page_idx}] Check the popup window - do you see a mega.nz link?")
                print(f"   [{page_idx}] Look for any buttons, links, or elements that might lead to mega.nz")
                print(f"   [{page_idx}] Press ENTER to continue extraction...")
                input(f"   [{page_idx}] (Hit ENTER once you've inspected the popup)")
                
                # Check if the popup's actual URL is the mega link
                if 'mega.nz' in popup.url:
                    result = popup.url
                    print(f"   [{page_idx}] ✓ Found mega.nz in popup URL: {result}")
                    # DON'T CLOSE YET - keep popup open for verification for 5 seconds
                    await asyncio.sleep(5)
                    return result
                    
                # Otherwise scrape all anchor tags on the new tab
                print(f"   [{page_idx}] Scraping anchor tags from popup for mega.nz links...")
                hrefs = await popup.evaluate("() => Array.from(document.querySelectorAll('a')).map(a => a.href)")
                print(f"   [{page_idx}] Found {len(hrefs)} links in popup")
                
                result = popup.url
                for href in hrefs:
                    print(f"   [{page_idx}]   Link: {href}")
                    if 'mega.nz' in href:
                        result = href
                        print(f"   [{page_idx}] ✓ Found mega.nz in popup's anchor tags: {result}")
                        break
                
                # Keep the popup open for user verification
                print(f"   [{page_idx}] ========== MEGA LINK FOUND ==========")
                print(f"   [{page_idx}] Result: {result}")
                print(f"   [{page_idx}] Keeping popup open for 10 seconds for verification...")
                await asyncio.sleep(10)
                return result
            else:
                print(f"   [{page_idx}] #cta-button selector completed but returned null/None.")
            
        except Exception as inner_e:
            print(f"   [{page_idx}] CTA extraction phase failed (Bot detection? Hidden button?): {type(inner_e).__name__} - {str(inner_e)}")
            print(f"   [{page_idx}] Attempting to solve RGS CAPTCHA...")
            captcha_solved = await solve_specific_captcha(page, page_idx)
            if captcha_solved:
                print(f"   [{page_idx}] CAPTCHA solved! Retrying button click...")
                try:
                    btn = await page.query_selector('#cta-button')
                    if btn:
                        async with context.expect_page(timeout=15000) as new_page_info:
                            await btn.click(delay=random.randint(50, 200), force=True)
                        popup = await new_page_info.value
                        await popup.wait_for_load_state("domcontentloaded")
                        await asyncio.sleep(2)
                        if 'mega.nz' in popup.url:
                            result = popup.url
                            await popup.close()
                            print(f"   [{page_idx}] Found mega.nz after CAPTCHA!")
                            return result
                        hrefs = await popup.evaluate("() => Array.from(document.querySelectorAll('a')).map(a => a.href)")
                        for href in hrefs:
                            if 'mega.nz' in href:
                                await popup.close()
                                return href
                        await popup.close()
                except Exception as retry_e:
                    print(f"   [{page_idx}] Retry failed: {str(retry_e)}")
            
            debug_img = os.path.join(ARTIFACTS_DIR, f"debug_popup_{page_idx}.png")
            await page.screenshot(path=debug_img)
            print(f"   [{page_idx}] Captured debug physical screenshot at {debug_img}!")
            
        # Fallback if no popup spawned but page loaded
        print(f"   [{page_idx}] Proceeding to fallback inline anchor scraping on main page...")
        hrefs = await page.evaluate("() => Array.from(document.querySelectorAll('a')).map(a => a.href)")
        
        for href in hrefs:
            if 'mega.nz' in href:
                return href
                
        return page.url
        
    except Exception as e:
        print(f"   [{page_idx}] Fatal failure processing URL {url}: {str(e)}")
        if page:
            fatal_img = os.path.join(ARTIFACTS_DIR, f"debug_fatal_{page_idx}.png")
            await page.screenshot(path=fatal_img)
        return url
    finally:
        if page:
            await page.close()

def get_katfile_daily_uploaded_size():
    """Get total size of files already uploaded to Katfile today"""
    log_file = os.path.join(OUTPUT_DIR, "uploads_log.txt")
    if not os.path.exists(log_file):
        return 0
    
    today = datetime.date.today().isoformat()
    total_size = 0
    
    try:
        with open(log_file, 'r', encoding='utf-8') as f:
            for line in f:
                if today in line and 'katfile' in line.lower():
                    # Try to extract file size from log line
                    # Format: [2026-05-28] filename (1.23 GB) -> katfile
                    match = re.search(r'\(([\d.]+)\s*GB\)', line)
                    if match:
                        try:
                            size_gb = float(match.group(1))
                            total_size += size_gb * (1024 ** 3)
                        except:
                            pass
    except Exception as e:
        print(f"   [WARN] Error reading upload log: {e}")
    
    return total_size

def can_upload_to_katfile(new_file_size):
    """Check if file can be uploaded to Katfile without exceeding daily limit"""
    uploaded_today = get_katfile_daily_uploaded_size()
    available_space = KATFILE_DAILY_LIMIT - uploaded_today
    return new_file_size <= available_space

# ==============================================================================
# PYLOAD INTEGRATION
# ==============================================================================

def convert_bunkr_link(url):
    """Convert bunkr.la, bunkr.ru, bunkr.to, bunkr.is, bunkr.cr, etc. to balbums.st"""
    import re
    pattern = r'https?://(?:[a-zA-Z0-9-]+\.)?bunkr\.[a-z]+(/.*)?'
    match = re.match(pattern, url, re.IGNORECASE)
    if match:
        path = match.group(1) or ""
        return f"https://balbums.st{path}"
    return url

def classify_and_filter_url(url):
    """
    Classifies a URL and returns a tuple (action, processed_url)
    Actions:
      - 'rd': Process via Real-Debrid (mega.nz, etc.)
      - 'pyload': Queue directly to pyLoad without RD (balbums.st, cyberfile, etc.)
      - 'skip': Drop or ignore completely (fishing, telegram, discord, login/contact, rentry/pasterix)
    """
    url_lower = url.lower()
    
    # 1. Skip check: Drop fishing links
    if 'fishing' in url_lower:
        return 'skip', None
        
    # 2. Skip check: Ignore discord, telegram, rentry, pasterix, etc.
    skip_domains = ['discord.gg', 'discord.com', 't.me', 'telegram.me', 'telegram.org', 'rentry.co', 'rentry.org', 'pasterix.net']
    if any(domain in url_lower for domain in skip_domains):
        return 'skip', None
        
    # 3. Skip check: Ignore edit, login, contact, register, signup pages
    skip_keywords = ['/login', '/register', '/signup', '/contact', '/edit', '/about', '/faq']
    if any(keyword in url_lower for keyword in skip_keywords):
        return 'skip', None
        
    # 4. Convert bunkr links to balbums.st
    if 'bunkr.' in url_lower:
        converted_url = convert_bunkr_link(url)
        return 'pyload', converted_url
        
    # 5. Cyberfile links go to pyLoad
    if 'cyberfile.' in url_lower:
        return 'pyload', url
        
    # 6. Balbums links go to pyLoad
    if 'balbums.st' in url_lower:
        return 'pyload', url
        
    # 7. Real-Debrid hosts (Mega.nz is primary)
    if 'mega.nz' in url_lower or 'mega.co.nz' in url_lower:
        return 'rd', url
        
    return 'pyload', url

def check_pyload_api():
    """Check if pyLoad API is accessible"""
    global PYLOAD_ENABLED
    try:
        import requests
        headers = {"X-API-Key": PYLOAD_API_KEY}
        response = requests.get(f"{PYLOAD_API_URL}/status_server", headers=headers, timeout=3)
        if response.status_code == 200:
            PYLOAD_ENABLED = True
            print(f"[INIT] pyLoad API accessible at {PYLOAD_API_URL}")
            return True
    except Exception as e:
        PYLOAD_ENABLED = False
        print(f"[INIT] pyLoad API not accessible: {str(e)[:60]}")
    return False

def queue_links_to_pyload(links, package_name="Failed Downloads"):
    """
    Queue a list of links to pyLoad as a single package
    
    Args:
        links: List of download URLs
        package_name: Name for the package on pyLoad
    
    Returns:
        dict with status and package_id if successful
    """
    if not links or len(links) == 0:
        print(f"   [pyLoad] No links to queue")
        return None
    
    if not PYLOAD_ENABLED:
        check_pyload_api()
        if not PYLOAD_ENABLED:
            print(f"   [pyLoad] ✗ API not available at {PYLOAD_API_URL}")
            return None
    
    try:
        import requests
        import json
        
        # Create package with links
        package_data = {
            "name": package_name,
            "links": links
        }
        
        print(f"   [pyLoad] Queueing {len(links)} links to package: {package_name}")
        
        # pyLoad API: POST /v1/packages to create a new package
        response = requests.post(
            f"{PYLOAD_API_URL}/add_package",
            json=package_data,
            headers={"X-API-Key": PYLOAD_API_KEY},
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
            print(f"   [pyLoad] ✓ Queued {len(links)} links")
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
            print(f"   [pyLoad] Response: {response.text[:100]}")
            return None
            
    except Exception as e:
        print(f"   [pyLoad] ✗ Error queueing links: {str(e)[:100]}")
        return None

async def extract_links_from_rentry(rentry_url, browser, page_idx):
    """Extract all links from a Rentry page (not just mega.nz)"""
    page = None
    try:
        print(f"   [{page_idx}] Extracting all links from Rentry page...")
        page = await browser.new_page()
        
        await page.goto(rentry_url, wait_until="domcontentloaded", timeout=8000)
        await asyncio.sleep(1)
        
        # Extract all URLs from the page
        all_links = await page.evaluate(r"""
            () => {
                const links = new Set();
                
                // Get links from <a> tags
                document.querySelectorAll('a[href]').forEach(a => {
                    const href = a.href.trim();
                    if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
                        links.add(href);
                    }
                });
                
                // Get URLs from text content (mega.nz, gdrive.com, etc.)
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

# ==============================================================================



async def main():
    import argparse
    import sys
    
    parser = argparse.ArgumentParser(description="Telethon Scraper Link Resolver")
    parser.add_argument("--non-interactive", action="store_true", default=None, help="Run in non-interactive mode")
    parser.add_argument("--no-clone", action="store_true", help="Do not clone Chrome user profile")
    args, unknown = parser.parse_known_args()
    
    if args.non_interactive is None:
        args.non_interactive = not sys.stdin.isatty()
        if args.non_interactive:
            print("[INFO] Stdin is not a TTY. Automatically enabling --non-interactive mode.")
            
    print(f"[{datetime.datetime.now()}] Starting Telethon scraper with RIP Linkvertise API...")
    print(f"[INFO] Available browsers: Firefox={FIREFOX_AVAILABLE}, Chrome={CHROME_AVAILABLE}")
    print(f"[INFO] Download directory: {DOWNLOAD_DIR}")
    
    # Initialize the Telethon client
    client = TelegramClient(SESSION_NAME, API_ID, API_HASH)
    await client.start() # type: ignore
    
    # Populate the internal entity cache so that bare integer IDs can be resolved
    print("Fetching dialogs to populate entity cache...")
    await client.get_dialogs()
    
    # Handle both single channel (string) and multiple channels (tuple)
    channels = CHANNEL_NAME if isinstance(CHANNEL_NAME, tuple) else (CHANNEL_NAME,)
    print(f"Connected to Telegram! Fetching from {len(channels)} channel(s): {channels}...")
    if MESSAGE_SKIP > 0:
        print(f"[INFO] Skipping first {MESSAGE_SKIP} messages per channel (MESSAGE_SKIP={MESSAGE_SKIP})")
    
    links = set()
    failed_channels = []
    
    # Iterate through each channel and collect links
    for channel in channels:
        print(f"  Processing channel: {channel}")
        try:
            message_count = 0
            async for message in client.iter_messages(channel, limit=MESSAGE_LIMIT + MESSAGE_SKIP):
                message_count += 1
                if message_count <= MESSAGE_SKIP:
                    continue  # Skip first N messages
                if not message.text or not message.entities:
                    continue
                    
                # Telethon conveniently parses embedded links natively
                for entity, text in message.get_entities_text():
                    url = None
                    if isinstance(entity, MessageEntityUrl):
                        url = text
                    elif isinstance(entity, MessageEntityTextUrl):
                        url = entity.url
                        
                    if url:
                        links.add(url)
            print(f"    [OK] Found {message_count - MESSAGE_SKIP} valid messages from {channel}")
        except ValueError as e:
            error_msg = f"Channel error: {channel} - {str(e)}"
            print(f"    [FAIL] {error_msg}")
            failed_channels.append(channel)
            send_notification("Channel Error", error_msg, 15)
            continue
        except Exception as e:
            error_msg = f"Unexpected error on {channel}: {type(e).__name__}: {str(e)}"
            print(f"    [FAIL] {error_msg}")
            failed_channels.append(channel)
            send_notification("Pipeline Error", error_msg, 15)
            continue
    
    # Report results
    if failed_channels:
        print(f"\n[WARNING] Failed to process {len(failed_channels)} channel(s): {failed_channels}")
    
    if not links:
        msg = "No links found in the recent messages from any accessible channel."
        print(msg)
        send_notification("Pipeline Complete", msg, 10)
        return
        
    print(f"Found {len(links)} raw links! Initially resolving redirects to locate linkvertise.com...")
    
    linkvertise_links = {}  # Map .com -> .lol for tracking
    for idx, raw_url in enumerate(links, 1):
        actual_url = resolve_initial_url(raw_url)
        if 'linkvertise.com' in actual_url:
            converted = actual_url.replace('linkvertise.com', 'linkvertise.lol')
            linkvertise_links[actual_url] = converted  # Store both versions
            print(f"[{idx}/{len(links)}] Found Linkvertise! Original: {actual_url}")
        else:
            print(f"[{idx}/{len(links)}] Ignored Non-Linkvertise link")

    if not linkvertise_links:
        print("No linkvertise links were found after resolving. Exiting.")
        return
        
    intermediate_file = os.path.join(OUTPUT_DIR, "linkvertise_links.txt")
    with open(intermediate_file, 'w', encoding='utf-8') as f:
        for link_com, link_lol in sorted(linkvertise_links.items()):
            f.write(f"{link_com}\n")
    print(f"Saved {len(linkvertise_links)} intermediate .com links to {intermediate_file}")
    
    # Save RIP bypass URLs for reference
    rip_bypass_file = os.path.join(OUTPUT_DIR, "rip_bypass_urls.txt")
    with open(rip_bypass_file, 'w', encoding='utf-8') as f:
        for link_com in sorted(linkvertise_links.keys()):
            encoded_url = quote(link_com, safe='')
            rip_url = f"{RIP_API_ENDPOINT}?url={encoded_url}&apikey={RIP_API_KEY}"
            f.write(f"{rip_url}\n")
    print(f"Saved {len(linkvertise_links)} RIP bypass URLs to {rip_bypass_file}")

    print(f"[EXTRACTION] Using browser-based RIP bypass to extract rentry.co links...")
    print(f"[INFO] Real-Debrid integration: {'ENABLED' if REALDEBRID_API_TOKEN else 'DISABLED (no token)'}")
    print(f"[INFO] Katfile upload: {'ENABLED' if KATFILE_API_KEY else 'DISABLED (no API key)'}")
    print(f"[INFO] Local downloads: {DOWNLOAD_DIR}")
    
    resolved = set()
    downloads = []
    
    cleanup_profile = None
    if not args.no_clone:
        try:
            user_data_dir_orig = r"C:\Users\Administrator\AppData\Local\Google\Chrome\User Data"
            user_data_dir, cleanup_profile = get_chrome_profile(user_data_dir_orig)
            import atexit
            atexit.register(cleanup_profile)
        except Exception as e:
            print(f"[WARN] Failed to clone Chrome profile: {e}. Falling back to original profile directory.")
            user_data_dir = r"C:\Users\Administrator\AppData\Local\Google\Chrome\User Data"
    else:
        user_data_dir = r"C:\Users\Administrator\AppData\Local\Google\Chrome\User Data"

    async with async_playwright() as p:
        # Use Persistent Context to allow Real-Debrid extension to work
        print(f"[INFO] Launching Chrome Persistent Context (for Real-Debrid Extension)...")
        browser = None
        for attempt in range(1, 4):
            try:
                browser = await p.chromium.launch_persistent_context(
                    user_data_dir,
                    executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                    headless=False,
                    ignore_default_args=["--disable-extensions", "--enable-automation", "--no-sandbox"],
                    args=['--disable-blink-features=AutomationControlled']
                )
                break
            except Exception as launch_err:
                print(f"[WARN] Attempt {attempt}/3 to launch browser failed: {launch_err}")
                if attempt == 3:
                    raise launch_err
                await asyncio.sleep(2)
        
        # Check if browser is logged in to Real-Debrid
        print("[Real-Debrid] Checking login status...")
        check_page = await browser.new_page()
        try:
            await check_page.goto("https://real-debrid.com/login", wait_until="domcontentloaded", timeout=15000)
            if "login" in check_page.url:
                print("[Real-Debrid] ⚠️ NOT LOGGED IN! Real-Debrid requires manual authentication.")
                is_interactive = sys.stdin.isatty() and not args.non_interactive
                if is_interactive:
                    print("[Real-Debrid] [INTERACTIVE] Please log in to Real-Debrid in the opened browser window.")
                    await asyncio.to_thread(input, ">>> Press ENTER in this console once you have logged in to Real-Debrid >>> ")
                else:
                    print("[Real-Debrid] [NON-INTERACTIVE] Running in non-interactive mode. Real-Debrid unrestriction may fail for MEGA links if the cloned profile session is expired.")
            else:
                print("[Real-Debrid] ✓ Already logged in.")
        except Exception as e:
            print(f"[Real-Debrid] [WARN] Could not verify login status: {e}")
        finally:
            await check_page.close()

        rentry_links = {}  # Map linkvertise -> rentry link
        for idx, link_com in enumerate(linkvertise_links.keys(), 1):
            print(f"\n[{idx}/{len(linkvertise_links)}] Processing: {link_com}")
            rentry_link = await bypass_linkvertise_in_browser(link_com, browser, idx)
            if rentry_link:
                rentry_links[link_com] = rentry_link
                print(f"   [OK] Got rentry link: {rentry_link}")
            else:
                print(f"   [FAIL] Failed to bypass")
        
        # Extract all URLs from rentry pages
        print(f"\n[EXTRACTION] Opening {len(rentry_links)} rentry pages to extract ALL links...")
        
        all_extracted_urls = set()
        for idx, (linkvertise, rentry) in enumerate(rentry_links.items(), 1):
            print(f"[{idx}/{len(rentry_links)}] Extracting links from: {rentry}")
            # Get all URLs, not just mega
            extracted_links = await extract_links_from_rentry(rentry, browser, idx)
            for l in extracted_links:
                all_extracted_urls.add(l)
                resolved.add(l)
                
        # Save all extracted links to file
        all_links_file = os.path.join(OUTPUT_DIR, "all_extracted_links.txt")
        with open(all_links_file, "w", encoding="utf-8") as f:
            for l in sorted(all_extracted_urls):
                f.write(l + "\n")
        print(f"\n[INFO] Saved {len(all_extracted_urls)} total extracted links to {all_links_file}")
        
        # Start the background uploader to run concurrently
        bg_uploader_task = asyncio.create_task(background_katfile_uploader())
        bg_dual_uploader_task = asyncio.create_task(background_dual_uploader())
        
        failed_links = []
        
        # Now process all found URLs with the Real-Debrid Browser Extension
        print(f"\n[BROWSER EXTENSION PROCESSING] Opening links to let Real-Debrid auto-unrestrict...")
        for idx, url in enumerate(sorted(all_extracted_urls), 1):
            action, processed_url = classify_and_filter_url(url)
            if action == 'skip':
                print(f"\n[{idx}/{len(all_extracted_urls)}] Skipping Link: {url}")
                continue
            elif action == 'pyload':
                print(f"\n[{idx}/{len(all_extracted_urls)}] Queueing directly to pyLoad: {processed_url}")
                failed_links.append(processed_url)
                continue
            url = processed_url
            print(f"\n[{idx}/{len(all_extracted_urls)}] Processing Link: {url}")
            
            # Navigate to the link
            page = await browser.new_page()
            
            captured_unrestricted = []
            # Listen to network requests for the unrestricted download URL
            async def on_req(req):
                if "real-debrid.com/d/" in req.url:
                    captured_unrestricted.append(req.url)
            page.on("request", on_req)
            
            # Add page load retry logic
            page_loaded = False
            for load_attempt in range(1, 3):
                try:
                    await page.goto(url, timeout=15000)
                    page_loaded = True
                    break
                except Exception as e:
                    print(f"   [WARN] Page load attempt {load_attempt}/2 failed: {str(e)[:50]}")
                    if load_attempt == 2:
                        print(f"   [WARN] Continuing but page may not have loaded fully.")
                    await asyncio.sleep(2)
            
            # Determine if we are in interactive mode
            is_interactive = sys.stdin.isatty() and not args.non_interactive
            
            unrestricted = None
            
            if is_interactive:
                print(f"   [INTERACTIVE] Please check the browser.")
                print(f"   If Real-Debrid extension hasn't captured it yet, wait or do it manually.")
                await asyncio.to_thread(input, "   >>> Press ENTER when the extension is done (or download has started) >>> ")
            else:
                # Non-interactive polling
                print(f"   [POLLING] Waiting up to 30 seconds for Real-Debrid extension to capture link...")
                for poll_sec in range(30):
                    if captured_unrestricted:
                        break
                    await asyncio.sleep(1)
            
            if captured_unrestricted:
                rd_url = captured_unrestricted[-1]
                print(f"   ✓ Extension captured unrestricted URL: {rd_url}")
                # Get file size and name with HEAD request
                import requests
                try:
                    head_resp = requests.head(rd_url, allow_redirects=True, timeout=10)
                    filesize = int(head_resp.headers.get("Content-Length", 0))
                    
                    filename = "unknown_file"
                    disp = head_resp.headers.get("Content-Disposition", "")
                    if "filename=" in disp:
                        filename = disp.split("filename=")[-1].strip('"\'')
                    elif "filename*" in disp:
                        filename = disp.split("''")[-1].strip()
                    
                    if filename == "unknown_file":
                        filename = rd_url.split("/")[-1]
                        
                    unrestricted = {
                        "download_url": rd_url,
                        "filename": filename,
                        "filesize": filesize
                    }
                except Exception as e:
                    print(f"   [WARN] Could not fetch HEAD info: {e}")
            
            if not unrestricted:
                # Fallback to API!
                print(f"   [FALLBACK] Extension did not capture link. Trying Real-Debrid API...")
                api_result = unrestrict_mega_with_realdebrid(url, idx)
                if api_result:
                    unrestricted = api_result
            
            if unrestricted:
                mega_link = url # Just to keep variable names compatible with the downstream logic
                
                # Downstream upload/download logic
                if True:
                    print(f"\n[{idx}] DOWNLOADING + FILTERING PHASE:")
                    
                    if unrestricted:
                        filesize = unrestricted['filesize']
                        filesize_gb = filesize / (1024 ** 3)
                        
                        # Category 1: Normal upload to Katfile (< 3GB)
                        if filesize <= MAX_FILESIZE_UPLOAD:
                            uploaded = False
                            
                            # Try Katfile first (if within daily quota)
                            if KATFILE_API_KEY and can_upload_to_katfile(filesize):
                                print(f"   [OK] Upload to Katfile ({filesize_gb:.2f}GB)...")
                                katfile_result = upload_to_katfile(
                                    unrestricted['download_url'],
                                    unrestricted['filename'],
                                    idx
                                )
                                
                                if katfile_result:
                                    downloads.append({
                                        'mega_url': mega_link,
                                        'filename': unrestricted['filename'],
                                        'katfile_url': katfile_result.get('katfile_url'),
                                        'size': filesize,
                                        'type': 'katfile'
                                    })
                                    uploaded = True
                            
                            # If Katfile failed or quota exceeded, try Google Drive
                            if not uploaded:
                                print(f"   [WARN] Katfile unavailable/quota exceeded, trying Google Drive...")
                                drive_service = get_google_drive_service()
                                
                                if drive_service:
                                    # Download file first
                                    download_path = await download_file_with_browser(
                                        unrestricted['download_url'],
                                        unrestricted['filename'],
                                        browser,
                                        idx
                                    )
                                    
                                    if download_path and os.path.exists(download_path):
                                        drive_result = upload_to_google_drive(
                                            download_path,
                                            unrestricted['filename'],
                                            drive_service,
                                            idx
                                        )
                                        
                                        if drive_result:
                                            downloads.append({
                                                'mega_url': mega_link,
                                                'filename': unrestricted['filename'],
                                                'drive_url': drive_result.get('drive_url'),
                                                'size': filesize,
                                                'type': 'gdrive'
                                            })
                                            uploaded = True
                                        
                                        # Clean up local copy after upload
                                        try:
                                            os.remove(download_path)
                                        except:
                                            pass
                                
                                # If Google Drive also failed, save to local fallback
                                if not uploaded:
                                    print(f"   [WARN] Google Drive failed, saving to {KATFILE_UPLOAD_DIR}...")
                                    download_path = await download_file_with_browser(
                                        unrestricted['download_url'],
                                        unrestricted['filename'],
                                        browser,
                                        idx
                                    )
                                    
                                    if download_path:
                                        overflow_path = os.path.join(KATFILE_UPLOAD_DIR, unrestricted['filename'])
                                        shutil.move(download_path, overflow_path)
                                        downloads.append({
                                            'mega_url': mega_link,
                                            'filename': unrestricted['filename'],
                                            'path': overflow_path,
                                            'size': filesize,
                                            'type': 'local_overflow'
                                        })
                        
                        # Category 2: Large file download exception (3GB-10GB → G:\TelethonDownloads)
                        elif filesize <= MAX_FILESIZE_DOWNLOAD:
                            print(f"   ✓ Large file exception: downloading to {LARGE_FILE_DOWNLOAD_DIR} ({filesize_gb:.2f}GB)...")
                            download_path = await download_file_with_browser(
                                unrestricted['download_url'],
                                unrestricted['filename'],
                                browser,
                                idx
                            )
                            
                            if download_path:
                                # Move to large file directory if not already there
                                try:
                                    if not download_path.lower().startswith(LARGE_FILE_DOWNLOAD_DIR.lower()):
                                        large_file_path = os.path.join(LARGE_FILE_DOWNLOAD_DIR, unrestricted['filename'])
                                        shutil.move(download_path, large_file_path)
                                        download_path = large_file_path
                                except:
                                    pass
                                
                                downloads.append({
                                    'mega_url': mega_link,
                                    'filename': unrestricted['filename'],
                                    'path': download_path,
                                    'size': filesize,
                                    'type': 'large_file'
                                })
                        
                        # Category 3: Too large, skip
                        else:
                            print(f"   ✗ File too large ({filesize_gb:.2f}GB), skipping (max 10GB)")
            else:
                print(f"   [INFO] No RD link captured. Adding to pyLoad batch queue.")
                failed_links.append(url)
            await page.close()
        
        await browser.close()
        
        # Queue failed links in batches of 50 to pyLoad
        if failed_links:
            print(f"\n[pyLoad] Found {len(failed_links)} failed links. Queueing to pyLoad in batches of 50...")
            for i in range(0, len(failed_links), 50):
                batch = failed_links[i:i+50]
                batch_idx = (i // 50) + 1
                queue_links_to_pyload(batch, package_name=f"Failed Links Batch {batch_idx}")
                
        # Wait for the background uploader to finish
        print("\n[BG Uploader] Waiting for background uploader to complete...")
        await bg_uploader_task
        print("\n[BG Dual Uploader] Waiting for background dual uploader to complete...")
        await bg_dual_uploader_task
        

    
    # Append the resolved MEGA URLs to our output file (never erase existing links)
    with open(OUTPUT_FILE, 'a', encoding='utf-8') as f:
        for url in sorted(resolved):
            f.write(url + '\n')
    
    # Write upload/download log if Real-Debrid was used
    if downloads:
        upload_log = os.path.join(OUTPUT_DIR, "uploads_log.txt")
        with open(upload_log, 'a', encoding='utf-8') as f:  # Append mode to preserve history
            f.write(f"\n[{datetime.datetime.now()}] Batch Upload/Download ({len(downloads)} files)\n")
            f.write("=" * 80 + "\n\n")
            for i, dl in enumerate(downloads, 1):
                f.write(f"[{i}] {dl['filename']}\n")
                f.write(f"    MEGA: {dl['mega_url']}\n")
                f.write(f"    Size: {dl['size'] / (1024**3):.2f} GB\n")
                f.write(f"    Type: {dl.get('type', 'unknown')}\n")
                if dl.get('katfile_url'):
                    f.write(f"    Katfile: {dl['katfile_url']}\n")
                if dl.get('path'):
                    f.write(f"    Local Path: {dl['path']}\n")
                f.write("\n")
        print(f"\n[UPLOADS] Saved {len(downloads)} upload records to {upload_log}")
    
    # Summary and notifications
    print(f"\n[{datetime.datetime.now()}] Success! Saved {len(resolved)} MEGA URLs to {OUTPUT_FILE}.")
    
    if downloads:
        katfile_count = sum(1 for d in downloads if d.get('katfile_url'))
        large_file_count = sum(1 for d in downloads if d.get('type') == 'large_file')
        local_count = sum(1 for d in downloads if d.get('path') and d.get('type') not in ['large_file'])
        
        summary_parts = []
        if katfile_count > 0:
            summary_parts.append(f"Uploaded {katfile_count} files to Katfile")
            print(f"[{datetime.datetime.now()}] Uploaded {katfile_count} files to Katfile (< 3GB).")
        if large_file_count > 0:
            summary_parts.append(f"Downloaded {large_file_count} large files (3-10GB)")
            print(f"[{datetime.datetime.now()}] Downloaded {large_file_count} large files (3-10GB) to {LARGE_FILE_DOWNLOAD_DIR}.")
        if local_count > 0:
            summary_parts.append(f"Downloaded {local_count} files locally")
            print(f"[{datetime.datetime.now()}] Downloaded {local_count} files locally to {DOWNLOAD_DIR}.")
        
        # Send Windows notification
        if summary_parts:
            notification_msg = "\n".join(summary_parts)
            send_notification(
                "Telethon Pipeline Complete",
                notification_msg,
                duration=10
            )
    else:
        send_notification("Telethon Pipeline", "No files to upload/download", duration=5)

if __name__ == '__main__':
    asyncio.run(main())

