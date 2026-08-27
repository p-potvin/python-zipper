# Python Zipper

Lightweight python server downloader scraper zipper uploader sorter machiner learner manager for your daily data consuming needs.

A centralized repository and automated container for all web download/upload management workflows, integrating local scrapers, computer vision filters, and cloud pipelines.

## Project Structure

This project consists of three core automation pipelines:

### 1. Dataset Builder (`dataset_builder/`)

An automated image pipeline designed to fetch, organize, deduplicate, and filter images:

* **Background API Server**: Integrated into the central **VaultWares API** (`vaultwares-api` on `https://100.67.25.118:9001`) to receive and process scraping/downloading payloads from browser extensions. (Legacy fallback server `server.py` runs on `http://127.0.0.1:5171`).
* **Scraper Tool (`scraper.py`)**: Downloads and packages images from any website using standard HTTP requests or browser rendering via Playwright, creating zip archives in batches of 100.
* **Extraction & Deduplication Pipeline (`unzip_dedupe.ps1`)**: Scans the `.downloaded/` folder, extracts zip files, runs Czkawka CLI to find and isolate duplicate images (keeping the oldest), and moves processed archives to `.downloaded/.completed/`.
* **AI Person Detection Filter (`face_detector.py`)**: Runs the Hugging Face `facebook/detr-resnet-50` object detection model on extracted images. It automatically keeps only the images containing exactly **one** person, moving all other images to `.downloaded/.completed/`.

#### Dataset Builder Request Flow

The dataset builder has two entry points: **CLI mode** (`scraper.py` standalone) and **Server mode** (`server.py` HTTP API). Both ultimately save files to the same destination: `.downloaded/` at the project root.

**CLI Mode (`scraper.py`)**

1. **Input**: `python scraper.py --url <URL> [--selector <CSS>] [--dest <DIR>] [--batch-size N] [--playwright]`
2. **Scrape**:
   * Without `--playwright`: sends `GET <URL>` with a Chrome User-Agent header, parses HTML with BeautifulSoup, extracts all `<img>` `src`/`data-src`/`href` attributes, resolves relative URLs via `urljoin`, and de-duplicates.
   * With `--playwright`: launches a headless Chromium browser, navigates to the URL, waits for `networkidle`, optionally waits for a CSS selector, then evaluates JavaScript to extract all `<img>` `href`/`src` attributes. Resolves and de-duplicates the same way.
3. **Download**: For each unique image URL, sends `GET <img_url>` with a Chrome User-Agent header (10s timeout). Binary content is kept in memory.
4. **Zip & Save**: Images are written into ZIP archives (stored, not compressed) in the destination directory. Each archive is named `{url_slug}_{random_number}.zip` where `url_slug` is derived from the URL path. Files inside the zip are named `{url_slug}_{NNN}.{ext}` (zero-padded index). When `batch_size` is reached, the current zip is closed and a new one is created.
5. **Output**: ZIP archives saved to `--dest` (default: `<project_root>/.downloaded/`).

**Server Mode (`server.py` on port 5171)**

The server exposes several HTTP endpoints. Scraping and downloading run in background threads.

| Endpoint | Method | Purpose | Files Saved |
|---|---|---|---|
| `POST /scrape` | POST | Scrapes a URL for images, then downloads and zips them. Body: `{url, selector, playwright, batch_size}` | ZIP archives in `.downloaded/` |
| `POST /download` | POST | Downloads pre-collected links (images zipped, non-images saved directly). Body: `{url, links[], batch_size}` | ZIP archives or raw files in `.downloaded/` |
| `POST /logs` | POST | Receives log entries from remote nodes. Body: `{node, message, timestamp, ...}` | `central-logs/{node}.log` |
| `GET /qa-logs` | GET | Returns last 200 log entries as JSON | None (read-only) |
| `GET /api/upscaler/status` | GET | Checks local upscaler availability (spandrel + model files + CUDA) | None (read-only) |
| `POST /api/open-downloaded` | POST | Deprecated v1.32 compatibility resolver; returns an existing absolute path but never launches Explorer | None (read-only) |
| `GET /api/huggingface/*` | GET | Proxies requests to `https://huggingface.co/api/*` | None (proxy) |
| `GET /api/civitai/*` | GET | Proxies requests to `https://civitai.red/api/*` | None (proxy) |
| `GET /api/comfyui/*` | GET | Proxies requests to `http://127.0.0.1:8188` | None (proxy) |
| `GET /api/ollama/*` | GET | Proxies requests to `http://127.0.0.1:11434` | None (proxy) |
| `GET /api/jobs/*` | GET | Proxies requests to VaultWares API (`http://100.67.25.118:9001`) | None (proxy) |
| `GET /api/abort/*` | GET/POST | Proxies abort requests to VaultWares API | None (proxy) |
| `GET /health` | GET | Health check, returns `{"status":"online"}` | None |

**Server `/scrape` and `/download` detail flow**:

1. **Link resolution**: Raw links are resolved to absolute URLs via `urljoin` and de-duplicated.
2. **Linkvertise bypass**: If a link contains `linkvertise.com`, `direct-link.net`, `link-center.net`, `link-hub.net`, or `link-target.net`, it is sent to bypass services (`trw.lat`, `api.bypass.vip`, `free.bypass-api.com`) to resolve the real destination.
3. **Real-Debrid unrestriction**: If a link points to a premium host (`mega.nz`, `keep2share.cc`, `k2s.cc`, `fileboom.me`, `fboom.me`, `rapidgator.net`, `rg.to`, `katfile.com`, `tezfiles.com`, `pixeldrain.com`), it is unrestricted via the Real-Debrid API (`api.real-debrid.com/rest/1.0/unrestrict/link`) using a token from `.access/realdebrid_api.txt`.
4. **Image vs. non-image routing**: Links with image extensions (`jpg`, `jpeg`, `png`, `gif`, `webp`, `svg`) are collected into a batch. Non-image links are downloaded directly as standalone files in background threads.
5. **Image zip**: Image content is downloaded via `scraper.download_image()` and written into `{url_slug}_{random}.zip` archives in `.downloaded/`, with files named `{url_slug}_{NNN}.{ext}`. Archives are split every `batch_size` images.
6. **Non-image direct download**: Non-image files are streamed (8KB chunks) and saved as-is to `.downloaded/{filename}`. The filename is extracted from the `Content-Disposition` header, or from the URL path, or generated as `download_{md5hash}.bin` as fallback.

**All files saved by the dataset builder go to**:

| Path | Contents |
|---|---|
| `.downloaded/` | ZIP archives of images, direct-downloaded non-image files |
| `.downloaded/.completed/` | Processed archives and rejected images (moved by `unzip_dedupe.ps1` and `face_detector.py`) |
| `central-logs/{node}.log` | Append-only JSON log lines from remote nodes (via `POST /logs`) |

### 2. Telegram Uploader Pipeline (`telegram/`)

A background pipeline for parsing links, resolving hosts, and cloud upload orchestration:

* **Link Resolver (`telethon_link_resolver.py`)**: Resolves links from Telethon-monitored channels.
* **Real-Debrid & Premium Downloader**: Integrates Real-Debrid endpoints to bypass hoster limits for files.
* **Host Uploaders (`k2s_uploader.py`, etc.)**: Handles high-performance multi-threaded uploads to premium hosts like Keep2Share and Katfile.
* **Task Scheduler (`setup_telegram_task.ps1`)**: Sets up Windows Task Scheduler to automate file retrieval and uploader scripts in the background.

### 3. Linkvertise OVH Mullvad Downloader (`linkvertise/`)

A file-driven, dry-run-first scaffold for authorized Linkvertise-style links. It plans OVH execution through a separate `vw-linkvertise` Docker stack, routes downloader traffic through a dedicated `mullvad-rotation` container, preserves per-link session state, and includes a systemd timer template for a 50-70 minute cadence.

---

## Getting Started

### Local Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/p-potvin/python-zipper.git
   cd python-zipper
   ```

2. The project relies on the `.venv` virtual environment which contains standard packages like PyTorch, Transformers, Playwright, Telethon, Pillow, and requests.

The background server is registered as a Windows Service `vaultwares-api` using NSSM. It runs automatically in the background on Delayed Start:

* Port: `9001`
* Status Check:

  ```powershell
  nssm status "vaultwares-api"
  ```

### Proxy & Evasion Configuration (TNLegend Tor Rotator / Web Unlocker)

`python-zipper` now features global proxy integration to bypass IP bans and evade detection using either the TNLegend Portable Tor Proxy Rotator or commercial residential proxies like Web Unlocker.

1. **Configure .env**
   In the root directory (or inside ../telegram/.env), you can define your PROXY_URL:
   * **For TNLegend Tor Rotator**: PROXY_URL=socks5://127.0.0.1:20000
   * **For Web Unlocker / Residential**: PROXY_URL=<http://username:password@proxy.webunlocker.com:12345>

2. **How it Works**
   * **Requests**: The proxy_utils.py module automatically monkey-patches the Python
equests library. Any outgoing HTTP request (e.g. fetching an image) is seamlessly routed through your proxy, while internal localhost APIs remain untouched.
   * **Patchright**: The PROXY_URL is parsed and securely injected into all patchright persistent browser contexts, ensuring that any headless browser scraping inherits the exact same IP rotation.

3. **Running the TNLegend Tor Rotator**
   If using the TNLegend rotator, you must start it manually before scraping:
   `ash
   cd "C:\Users\Administrator\Desktop\Github Repos\Portable-Tor-Proxy-Rotator"
   run_tor.bat
   `
   Wait for the message "Waiting for timer...". It will generate 50 SOCKS5 proxies starting at port 20000 and rotate IPs every 5 minutes.
