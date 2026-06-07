# Telegram Link Resolver Pipeline

An end-to-end automated Python pipeline that scrapes Telegram channels, bypasses Linkvertise/Link-Hub shorteners, extracts files from Rentry/Pasterix hubs, processes MEGA links via Real-Debrid, and uploads them to Google Drive and Katfile, utilizing PyLoad for fallback queue operations and local disk for large files.

---

## 🛠 Prerequisites & Dependencies

### 1. Python Environment

This pipeline uses a virtual environment at the project root (`.venv`). Ensure you have Python installed and install the required packages:

```powershell
# In the python-scripts root directory
python -m venv .venv
.venv\Scripts\activate
pip install telethon requests playwright playwright-stealth
playwright install
```

### 2. Required Authentication & Secrets

The pipeline securely accesses several external APIs. Your API tokens must be prepared locally:

1. **Telegram API**:
    - Retrieve `API_ID` and `API_HASH` from [my.telegram.org](https://my.telegram.org) under *API Development tools*.
2. **TRW API (Linkvertise Bypass)**:
    - By default, uses a free key `TRW_FREE-...`. You can get your own from [trw.lat](https://trw.lat/api).
3. **Real-Debrid API**:
    - Place your token at `{YOUR_TOKEN_PATH}\realdebrid_api.txt`.
4. **Katfile API**:
    - Place your Katfile Space API key at `C:\Users\Administrator\Desktop\Github Repos\.access\katfiles_api.txt`.
5. **Google Drive OAuth2**:
    - Create Google OAuth Creds and securely authenticate via Headless OAuth (generates `.gdrive_token.json` in the `telegram/` folder). See `docs/GDRIVE_OAUTH2_GUIDE.md` for exact steps.

---

## 🏗 Pipeline Workflow

1. **Telegram Scrape**: Authenticates via `telethon` and reads $N$ messages from defined `CHANNEL_NAME`(s). Extracts the link hubs (`link-hub.net`, etc.).
2. **Bypass Link Shorteners**: Submits the link-hub URL to the TRW API (`trw.lat/api/bypass`). Yields the true `rentry.co` or `pasterix.com` hub.
3. **Rentry Link Extraction** (Headless Playwright): Opens the hub asynchronously in Playwright. Identifies all `.mp4`, `.mkv`, `.avi` and generic MEGA links.
4. **Real-Debrid Resolution**:
    - Passes the collected MEGA links securely to the Real-Debrid API (`api.real-debrid.com/rest/1.0/unrestrict/link`).
    - Exposes the raw unrestricted download link.
5. **Action Router (The Filter Stage)**:
    Checks the `max_filesize` reported by Real-Debrid.
    - **< 2GB**: Remote-Uploads back to **Katfile Space**.
    - **2GB - 3GB**: Uploads standard to **Google Drive**.
    - **3GB - 10GB**: Direct localized download into `G:\TelethonDownloads\`.
    - **> 10GB**: Safely drops to unhandled or skipped.
6. **PyLoad Failover**: Any unresolved/dropped links inject payload into localhost PyLoad (`http://localhost:8003/api`) so they are not forgotten.

---

## 🚀 Execution & Usage

Because the pipeline is massive, we manage everything from the main integrated script:

### The Main Script

```powershell
# From the root "python-scripts" directory, ensure you use the virtual environment
.venv\Scripts\python.exe telegram\telethon_link_resolver.py
```

### CLI Arguments & Options

The script supports the following command-line flags:

- `--non-interactive`: Runs the script in non-interactive mode (no user keyboard prompts). Instead of pausing for manual action, it polls the Real-Debrid extension for 30 seconds and automatically falls back to the Real-Debrid REST API on timeout. This mode is **automatically enabled** if the script is run in a non-TTY environment (like Windows Task Scheduler).
- `--no-clone`: Disables parallel Chrome profile cloning. By default, the pipeline clones the essential files of your Google Chrome profile to a temporary directory so the script can run concurrently with an open Google Chrome browser without profile locking errors.

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

## 📂 Directory Structure

| Directory/File | Purpose |
| ---------------- | --------- |
| `telethon_link_resolver.py` | **(CORE)** The primary integration master script covering all tasks from scraping Telegram to transferring outputs! |
| `docs/` | Contains the guides for environment tweaks, OAuth troubleshooting, and Mega integration (`PIPELINE_SETUP_GUIDE.md`, etc.). |
| `tests/` | Granular unit tests checking the isolated functions of GDrive (`test_gdrive_api.py`), Katfile mock servers, etc. |
| `output/` | Dynamic TXT/CSV mapping produced in real-time indicating what links are extracted, failed, and ready for Pyload. |
| `artifacts/` | Screenshots and debug HTML from Headless Chromium when nodes fail. |
| `sessions/` | Stores the `automated_scraper_session.session` SQLite DB, preventing repeated Telegram MFA log-ins. |

---

## ⚙ Configurable Parameters

If you need to change targets or limits, edit `telethon_link_resolver.py` directly:

- `CHANNEL_NAME = ('@Channel1', '1822378085')`: Add/Remove telegram targets.
- `MESSAGE_LIMIT = 5`: Increase to ingest deeper sweeps of older telegram posts.
- `MESSAGE_SKIP = 0`: Offset to skip the most recently posted links (if already indexed).
- `MAX_FILESIZE_UPLOAD = 3 * 1024 * 1024 * 1024`: Boundary before switching from network uploads to local direct caching.
- `LARGE_FILE_DOWNLOAD_DIR = r"G:\TelethonDownloads"`: Target for files exceeding `MAX_FILESIZE_UPLOAD`.
- `PYLOAD_API_URL = "http://localhost:8003/api"`: Failsafe download client API port.
