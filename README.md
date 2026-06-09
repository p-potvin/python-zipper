# Python Zipper

Lightweight python server downloader scraper zipper uploader sorter machiner learner manager for your daily data consuming needs.

A centralized repository and automated container for all web download/upload management workflows, integrating local scrapers, computer vision filters, and cloud pipelines.

## Project Structure

This project consists of two core automation pipelines:

### 1. Dataset Builder (`dataset_builder/`)

An automated image pipeline designed to fetch, organize, deduplicate, and filter images:

* **Background API Server**: Integrated into the central **VaultWares API** (`vaultwares-api` on `http://127.0.0.1:9001`) to receive and process scraping/downloading payloads from browser extensions. (Legacy fallback server `server.py` runs on `http://127.0.0.1:5171`).
* **Scraper Tool (`scraper.py`)**: Downloads and packages images from any website using standard HTTP requests or browser rendering via Playwright, creating zip archives in batches of 100.
* **Extraction & Deduplication Pipeline (`unzip_dedupe.ps1`)**: Scans the `.downloaded/` folder, extracts zip files, runs Czkawka CLI to find and isolate duplicate images (keeping the oldest), and moves processed archives to `.downloaded/.completed/`.
* **AI Person Detection Filter (`face_detector.py`)**: Runs the Hugging Face `facebook/detr-resnet-50` object detection model on extracted images. It automatically keeps only the images containing exactly **one** person, moving all other images to `.downloaded/.completed/`.

### 2. Telegram Uploader Pipeline (`telegram/`)

A background pipeline for parsing links, resolving hosts, and cloud upload orchestration:

* **Link Resolver (`telethon_link_resolver.py`)**: Resolves links from Telethon-monitored channels.
* **Real-Debrid & Premium Downloader**: Integrates Real-Debrid endpoints to bypass hoster limits for files.
* **Host Uploaders (`k2s_uploader.py`, etc.)**: Handles high-performance multi-threaded uploads to premium hosts like Keep2Share and Katfile.
* **Task Scheduler (`setup_telegram_task.ps1`)**: Sets up Windows Task Scheduler to automate file retrieval and uploader scripts in the background.

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
