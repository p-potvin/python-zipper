"""
Configuration module extracted from telethon_link_resolver.py.
Loads environment variables, sets up directories, and configures uploaders.
"""

import os
from dotenv import load_dotenv
import uploaders


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(SCRIPT_DIR, ".env"))
except ImportError:
    pass

API_ID = int(os.environ.get("TELEGRAM_API_ID", 0))
API_HASH = os.environ.get("TELEGRAM_API_HASH", "")

CHANNEL_NAME = (-1001822378085, -1001164086858, -1003825953196)
MESSAGE_LIMIT = 1
MESSAGE_SKIP = 0

OUTPUT_DIR = os.path.join(SCRIPT_DIR, "logs")
ARTIFACTS_DIR = os.path.join(SCRIPT_DIR, "artifacts")
SESSIONS_DIR = os.path.join(SCRIPT_DIR, "sessions")
ASSETS_DIR = os.path.join(SCRIPT_DIR, "assets")

for dir_path in [OUTPUT_DIR, ARTIFACTS_DIR, SESSIONS_DIR]:
    if not os.path.exists(dir_path):
        os.makedirs(dir_path)

OUTPUT_FILE = os.path.join(OUTPUT_DIR, "resolved_links.txt")
SESSION_NAME = os.path.join(SESSIONS_DIR, "automated_scraper_session")

BROWSER_PROFILE_DIR = os.path.join(SCRIPT_DIR, "browser_profile")
if not os.path.exists(BROWSER_PROFILE_DIR):
    os.makedirs(BROWSER_PROFILE_DIR)

RIP_API_KEY = os.environ.get("TRW_API_KEY", "")
RIP_API_ENDPOINT = 'https://trw.lat/api/bypass'

STANDARD_FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
STANDARD_CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
FIREFOX_AVAILABLE = os.path.exists(STANDARD_FIREFOX)
CHROME_AVAILABLE = os.path.exists(STANDARD_CHROME)

REALDEBRID_API_TOKEN = os.environ.get("REALDEBRID_API_KEY", "")
REALDEBRID_API_BASE = "https://api.real-debrid.com/rest/1.0"

ALLDEBRID_TOKEN_PATH = os.path.join(os.path.dirname(os.path.dirname(SCRIPT_DIR)), ".access", "alldebrid.token.txt")
ALLDEBRID_API_KEY = os.environ.get("ALLDEBRID_API_KEY", "")
if not ALLDEBRID_API_KEY and os.path.exists(ALLDEBRID_TOKEN_PATH):
    try:
        with open(ALLDEBRID_TOKEN_PATH, "r", encoding="utf-8") as _af:
            ALLDEBRID_API_KEY = _af.read().strip()
    except Exception as _e:
        print(f"[Config] Error reading AllDebrid token: {_e}")
ALLDEBRID_API_BASE = "https://api.alldebrid.com/v4"

PLAYLISTS_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), "playlists")
if not os.path.exists(PLAYLISTS_DIR):
    os.makedirs(PLAYLISTS_DIR, exist_ok=True)

KATFILE_API_KEY = os.environ.get("KATFILE_API_KEY", "")
KATFILE_API_BASE = "https://katfile.space/api"
KATFILE_UPLOAD_SERVER_ENDPOINT = "https://katfile.space/api/upload/server"
KATFILE_DOMAIN = "https://katfile.space"

CLOUD_STORAGE_KEYS_FILE = os.path.join(os.path.dirname(os.path.dirname(SCRIPT_DIR)), ".access", "cloud_storage_keys.txt")
PIXELDRAIN_KEY = ""
ONEFICHIER_KEY = ""
GOFILE_KEY = ""
if os.path.exists(CLOUD_STORAGE_KEYS_FILE):
    try:
        with open(CLOUD_STORAGE_KEYS_FILE, "r", encoding="utf-8") as _f:
            for _line in _f:
                _line = _line.strip()
                if "=" in _line:
                    _k, _v = _line.split("=", 1)
                    if _k.lower() == "pixeldrain": PIXELDRAIN_KEY = _v
                    elif _k.lower() == "1fichier": ONEFICHIER_KEY = _v
                    elif _k.lower() == "gofile": GOFILE_KEY = _v
    except Exception as _e:
        print(f"[Config] Error loading cloud storage keys: {_e}")

PYLOAD_API_URL = os.environ.get("PYLOAD_API_URL", "http://localhost:8003/api")
PYLOAD_API_KEY = os.environ.get("PYLOAD_API_KEY", "pl_11qb0iw6-Pdm9hf1lhqS4y_0vOBnjaunDZZdGNE97S0QQ")
PYLOAD_ENABLED = True

DOWNLOAD_DIR = r"G:\mega"

_current_run_files = set()

MAX_FILESIZE_UPLOAD = 2 * 1024 * 1024 * 1024
MAX_FILESIZE_DOWNLOAD = 2 * 1024 * 1024 * 1024
LARGE_FILE_DOWNLOAD_DIR = r"G:\TelethonDownloads"

KATFILE_DAILY_LIMIT = 2 * 1024 * 1024 * 1024
KATFILE_UPLOAD_DIR = r"G:\KatfileOverflow"

if not os.path.exists(LARGE_FILE_DOWNLOAD_DIR):
    os.makedirs(LARGE_FILE_DOWNLOAD_DIR)
    print(f"[INIT] Created large file download directory: {LARGE_FILE_DOWNLOAD_DIR}")

if not os.path.exists(KATFILE_UPLOAD_DIR):
    os.makedirs(KATFILE_UPLOAD_DIR)
    print(f"[INIT] Created Katfile overflow directory: {KATFILE_UPLOAD_DIR}")

uploaders.configure(
    KATFILE_API_KEY=KATFILE_API_KEY,
    KATFILE_API_BASE=KATFILE_API_BASE,
    KATFILE_UPLOAD_SERVER_ENDPOINT=KATFILE_UPLOAD_SERVER_ENDPOINT,
    KATFILE_DOMAIN=KATFILE_DOMAIN,
    KATFILE_DAILY_LIMIT=KATFILE_DAILY_LIMIT,
    PIXELDRAIN_KEY=PIXELDRAIN_KEY,
    ONEFICHIER_KEY=ONEFICHIER_KEY,
    GOFILE_KEY=GOFILE_KEY,
    OUTPUT_DIR=OUTPUT_DIR,
)

if REALDEBRID_API_TOKEN:
    print(f"[INIT] Loaded Real-Debrid API token (length: {len(REALDEBRID_API_TOKEN)})")
else:
    print(f"[INIT] Warning: Failed to load Real-Debrid token from .env")

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
