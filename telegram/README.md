# Telegram Link Resolver Pipeline

An end-to-end automated Python pipeline that scrapes Telegram channels, bypasses Linkvertise/Link-Hub shorteners, extracts files from Rentry/Pasterix hubs, processes MEGA links via Real-Debrid browser extension, and uploads them to Katfile with cloud storage fallbacks (Pixeldrain, 1fichier, Gofile, K2S/FileBoom) and Google Drive, utilizing PyLoad for fallback queue operations and local disk for large files.

---

## Prerequisites & Dependencies

### 1. Python Environment

This pipeline uses a virtual environment at the project root (`.venv`). Ensure you have Python installed and install the required packages:

```powershell
# In the python-scripts root directory
python -m venv .venv
.venv\Scripts\activate
pip install telethon requests playwright playwright-stealth python-dotenv
playwright install
```

### 2. Required Authentication & Secrets

The pipeline securely accesses several external APIs. Your API tokens must be prepared locally:

1. **Telegram API**:
    - Retrieve `API_ID` and `API_HASH` from [my.telegram.org](https://my.telegram.org) under *API Development tools*.
2. **TRW API (Linkvertise Bypass)**:
    - By default, uses a free key `TRW_FREE-...`. You can get your own from [trw.lat](https://trw.lat/api).
3. **Real-Debrid API**:
    - Set `REALDEBRID_API_KEY` in `telegram/.env`.
    - **Important**: The Real-Debrid REST API does not work for MEGA links. The pipeline uses the Real-Debrid **browser extension** (installed in the persistent Chrome profile) to unrestrict MEGA links. The REST API is only used as a fallback for non-MEGA hosts.
4. **Katfile API**:
    - Set `KATFILE_API_KEY` in `telegram/.env`.
5. **Cloud Storage Fallback Keys**:
    - Place keys at `C:\Users\Administrator\Desktop\Github Repos\.access\cloud_storage_keys.txt`:
    ```
    pixeldrain=your-key
    1fichier=your-key
    gofile=your-key
    ```
6. **Google Drive OAuth2**:
    - Create Google OAuth Creds and securely authenticate via Headless OAuth (generates `.gdrive_token.json` in the `telegram/` folder). See `docs/GDRIVE_OAUTH2_GUIDE.md` for exact steps.

---

## Browser Persistence (Important)

The pipeline uses a **dedicated persistent Chrome profile** at `telegram/browser_profile/`. This directory:

- **Retains all extensions** (including Real-Debrid) between runs — no re-installation needed
- **Retains cookies and sessions** — no re-authentication needed after the first login
- **No profile cloning** — the profile is used directly, behaving like a normal browser

On first run, you will need to:
1. Install the Real-Debrid browser extension in the Chrome window that opens
2. Log in to Real-Debrid in the browser

After that, all subsequent runs will retain the session automatically. The pipeline checks login status on startup and will prompt you (in interactive mode) if re-authentication is needed.

---

## Pipeline Workflow

1. **Telegram Scrape**: Authenticates via `telethon` and reads N messages from defined `CHANNEL_NAME`(s). Extracts the link hubs (`link-hub.net`, etc.).
2. **Bypass Link Shorteners**: Uses browser-based TRW bypass to extract `rentry.co` or `pasterix.com` hub links.
3. **Rentry Link Extraction** (Playwright): Opens the hub and extracts all external links (not just MEGA).
4. **Real-Debrid Resolution** (Browser Extension):
    - Opens each link in Chrome with the Real-Debrid extension installed.
    - The extension auto-unrestricts MEGA links and captures the unrestricted download URL.
    - Falls back to Real-Debrid REST API for non-MEGA hosts.
5. **Upload with Fallback Chain**:
    - **Katfile** (remote stream, 2GB daily quota)
    - **Pixeldrain** (local file fallback)
    - **1fichier** (local file fallback)
    - **Gofile** (local file fallback)
    - **K2S/FileBoom** (local file fallback via `k2s_uploader.py`)
    - **Google Drive** (local file, final cloud fallback)
    - **Local overflow** (`G:\KatfileOverflow`)
6. **Large Files** (3GB-10GB): Downloaded directly to `G:\TelethonDownloads\`.
7. **PyLoad Failover**: Any unresolved/dropped links inject payload into PyLoad so they are not forgotten.

---

## Execution & Usage

### The Main Script

```powershell
# From the root "python-scripts" directory, ensure you use the virtual environment
.venv\Scripts\python.exe telegram\telethon_link_resolver.py
```

### CLI Arguments & Options

- `--non-interactive`: Runs the script in non-interactive mode (no user keyboard prompts). Instead of pausing for manual action, it polls the Real-Debrid extension for 30 seconds and automatically falls back to the Real-Debrid REST API on timeout. This mode is **automatically enabled** if the script is run in a non-TTY environment (like Windows Task Scheduler).

Example:

```powershell
# Run completely headlessly and non-interactively
.venv\Scripts\python.exe telegram\telethon_link_resolver.py --non-interactive
```

### Automation & Task Scheduling

If you want to run this pipeline mechanically in the background on Windows, we've provided ready-to-run PowerShell scripts that trigger Windows Scheduled Tasks.

- `setup_scheduled_task.ps1`: Registers the cron payload in Windows Task Scheduler.
- `run_pipeline_with_notification.ps1`: Wraps execution in Windows Notifications (Win10Toast) to alert the Desktop when links are actively resolved and uploaded.

To install the scheduled background task:

```powershell
# Open an elevated PowerShell and run:
.\telegram\setup_scheduled_task.ps1
```

### Validation & Diagnostics

To instantly test if your keys and APIs are active before risking a full pipeline execution:

```powershell
# Run the validation script
.venv\Scripts\python.exe telegram\validate_setup.py
.\telegram\validate_setup.ps1
```

---

## Module Architecture

| File | Purpose |
| --- | --- |
| `telethon_link_resolver.py` | **(CORE)** Main pipeline: Telegram scraping, Linkvertise bypass, RD extension handling, upload orchestration, background uploaders |
| `uploaders.py` | All cloud storage upload functions: Katfile, Pixeldrain, 1fichier, Gofile, K2S/FileBoom, fallback chain, Link Sharing registration, quota tracking |
| `pipeline_state.py` | `PipelineState` class for JSON-based state persistence (processed messages, upload counters) |
| `k2s_uploader.py` | K2S/FileBoom upload logic with instant hash matching and token extraction from MoneyPlatform desktop app |
| `docs/` | Guides for environment tweaks, OAuth troubleshooting, and Mega integration |
| `tests/` | Unit tests for GDrive, Katfile, pipeline integration, etc. |
| `output/` | Dynamic TXT/CSV mapping produced in real-time |
| `artifacts/` | Screenshots and debug HTML from Chromium when nodes fail |
| `sessions/` | Stores the `automated_scraper_session.session` SQLite DB, preventing repeated Telegram MFA log-ins |
| `browser_profile/` | **Persistent Chrome profile** — retains extensions, cookies, and sessions between runs |

---

## Configurable Parameters

If you need to change targets or limits, edit `telethon_link_resolver.py` directly:

- `CHANNEL_NAME = ('@Channel1', '1822378085')`: Add/Remove telegram targets.
- `MESSAGE_LIMIT = 5`: Increase to ingest deeper sweeps of older telegram posts.
- `MESSAGE_SKIP = 0`: Offset to skip the most recently posted links (if already indexed).
- `MAX_FILESIZE_UPLOAD = 3 * 1024 * 1024 * 1024`: Boundary before switching from network uploads to local direct caching.
- `LARGE_FILE_DOWNLOAD_DIR = r"G:\TelethonDownloads"`: Target for files exceeding `MAX_FILESIZE_UPLOAD`.
- `KATFILE_DAILY_LIMIT = 2 * 1024 * 1024 * 1024`: Katfile daily upload quota (2 GB). Files exceeding this fall back to other cloud services.
- `KATFILE_UPLOAD_DIR = r"G:\KatfileOverflow"`: Local overflow directory when all cloud services fail.
- `BROWSER_PROFILE_DIR = os.path.join(SCRIPT_DIR, "browser_profile")`: Persistent Chrome profile directory (retains extensions and sessions).
- `PYLOAD_API_URL`: Failsafe download client API port.
