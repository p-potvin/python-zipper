import os
import sys
import json
import random
import zipfile
import threading
import re
import requests
import subprocess
import time
import uuid
from urllib.parse import urlparse, urljoin
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingTCPServer

# Add current folder to path to allow importing scraper
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import scraper

PORT = 5171
DEST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".downloaded")
RD_TOKEN_PATH = r"C:\Users\Administrator\Desktop\Github Repos\.access\realdebrid_api.txt"

# VaultWares API on OVHCloud (for job tracking, cloud pipeline)
VAULTWARES_API = os.environ.get("VAULTWARES_API_URL", "https://api.vaultwares.ca:9001")
# Local upscaler models directory
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models")
NOMOS_MODEL_NAME = "4xNomos8k_atd"
NOMOS_MODEL_PATH = os.path.join(MODELS_DIR, f"{NOMOS_MODEL_NAME}.safetensors")
DEFAULT_RCLONE_REMOTES = "gdrive:python-zipper,proton:python-zipper"
IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "gif", "webp", "svg"}
UPSCALE_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
JOBS = {}
JOBS_LOCK = threading.Lock()

def get_available_upscale_models():
    models = []
    if os.path.exists(NOMOS_MODEL_PATH):
        models.append({
            "name": NOMOS_MODEL_NAME,
            "kind": "spandrel",
            "path": os.path.abspath(NOMOS_MODEL_PATH),
        })
    models.append({
        "name": "pillow-lanczos",
        "kind": "pillow",
        "path": "",
    })
    return models

def create_job(url, links, batch_size, upscale_enabled, upscale_model):
    now = int(time.time() * 1000)
    job_id = f"local-{uuid.uuid4().hex[:12]}"
    job = {
        "id": job_id,
        "status": "queued",
        "url": url,
        "total_links": len(links),
        "processed_links": 0,
        "images_count": 0,
        "archives": [],
        "batch_size": batch_size,
        "upscale_enabled": bool(upscale_enabled),
        "upscale_model": upscale_model,
        "rclone_complete": False,
        "created_at": now,
        "updated_at": now,
        "source": "local-python-zipper",
    }
    with JOBS_LOCK:
        # Purge older jobs to prevent accumulation (keep max 30)
        if len(JOBS) >= 30:
            sorted_keys = sorted(JOBS.keys(), key=lambda k: JOBS[k].get("created_at", 0))
            for k in sorted_keys[:(len(JOBS) - 29)]:
                del JOBS[k]
        JOBS[job_id] = job
    return job_id

def update_job(job_id, **changes):
    if not job_id:
        return
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job.update(changes)
        job["updated_at"] = int(time.time() * 1000)

def complete_job(job_id, archives=None, rclone_complete=False):
    update_job(
        job_id,
        status="completed",
        archives=list(archives or []),
        rclone_complete=bool(rclone_complete),
    )
    try:
        from win11toast import toast
        toast("Python Zipper Job Complete", f"Job {job_id[:12]} completed successfully.", duration="short")
    except Exception as e:
        print(f"[Server] Failed to send complete toast: {e}")

def fail_job(job_id, error):
    update_job(job_id, status="failed", error=str(error))
    try:
        from win11toast import toast
        toast("Python Zipper Job Failed", f"Job {job_id[:12]} failed: {error}", duration="short")
    except Exception as e:
        print(f"[Server] Failed to send fail toast: {e}")

def get_jobs_snapshot():
    with JOBS_LOCK:
        return {key: dict(value) for key, value in JOBS.items()}

def _configured_rclone_remotes():
    raw = os.environ.get("PYTHON_ZIPPER_RCLONE_REMOTES", DEFAULT_RCLONE_REMOTES)
    return [remote.strip() for remote in raw.split(",") if remote.strip()]

def handoff_to_rclone(file_path):
    """Move a completed download to the first configured rclone remote that accepts it."""
    if not file_path or not os.path.exists(file_path):
        return False

    for remote in _configured_rclone_remotes():
        destination = remote if remote.endswith(("/", ":")) else f"{remote}/"
        try:
            print(f"[Server] Moving completed download to rclone remote: {remote}")
            result = subprocess.run(
                ["rclone", "move", file_path, destination, "--create-empty-src-dirs"],
                capture_output=True,
                text=True,
                timeout=600,
            )
            if result.returncode == 0:
                print(f"[Server] rclone handoff complete: {remote}")
                return True
            print(f"[Server] rclone handoff failed for {remote}: {result.stderr.strip()}")
        except FileNotFoundError:
            print("[Server] rclone executable was not found. Keeping local file.")
            return False
        except Exception as e:
            print(f"[Server] rclone handoff exception for {remote}: {e}")

    print(f"[Server] All rclone remotes failed. Keeping local file: {file_path}")
    return False

def upscale_image_content(content, ext, model):
    if ext.lower() not in UPSCALE_IMAGE_EXTENSIONS:
        return content
    try:
        from upscale_image import upscale_bytes
        return upscale_bytes(content, model=model)
    except Exception as e:
        print(f"[Server] Local Python upscaling failed; keeping original image: {e}")
        return content

def get_rd_token():
    try:
        if os.path.exists(RD_TOKEN_PATH):
            with open(RD_TOKEN_PATH, 'r') as f:
                return f.read().strip()
    except Exception as e:
        print(f"[Server] Failed to read Real-Debrid token: {e}")
    return None

def unrestrict_link_rd(url, rd_token):
    if not rd_token:
        print("[Server] Real-Debrid token not available. Skipping unrestriction.")
        return url
    try:
        headers = {
            'Authorization': f'Bearer {rd_token}',
            'User-Agent': 'Mozilla/5.0'
        }
        resp = requests.post(
            "https://api.real-debrid.com/rest/1.0/unrestrict/link",
            headers=headers,
            data={'link': url},
            timeout=12
        )
        if resp.status_code == 200:
            data = resp.json()
            dl_url = data.get('download')
            if dl_url:
                print(f"[Server] Real-Debrid successfully unrestricted: {url} -> {dl_url}")
                return dl_url
        else:
            print(f"[Server] Real-Debrid error {resp.status_code}: {resp.text}")
    except Exception as e:
        print(f"[Server] Real-Debrid unrestriction exception: {e}")
    return url

def bypass_linkvertise(url):
    bypass_services = [
        "https://trw.lat/api/bypass",
        "https://api.bypass.vip/bypass",
        "https://free.bypass-api.com/bypass"
    ]
    for service in bypass_services:
        try:
            print(f"[Server] Attempting bypass via {service} for: {url}")
            resp = requests.get(service, params={'url': url}, timeout=12)
            if resp.status_code == 200:
                data = resp.json()
                res_link = None
                if data.get('success'):
                    res_link = data.get('result') or data.get('destination')
                elif 'destination' in data:
                    res_link = data['destination']
                elif 'result' in data:
                    res_link = data['result']
                
                if res_link and res_link.lower().startswith("http"):
                    return res_link
        except Exception as e:
            print(f"[Server] Bypass service {service} error: {e}")
    return url

class ScraperHandler(BaseHTTPRequestHandler):
    # Quiet server logging to avoid printing every request in console
    def log_message(self, format, *args):
        pass

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def _proxy_request(self, target_base_url, prefix_len):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else None
        
        # Prepare target URL
        subpath = self.path[prefix_len:]
        target_url = target_base_url.rstrip('/') + '/' + subpath.lstrip('/')
        if self.headers.get('Query-String'):
            target_url += "?" + self.headers.get('Query-String')
        
        # Prepare headers to forward
        forward_headers = {k: v for k, v in self.headers.items() if k.lower() not in ['host', 'content-length']}
        
        try:
            resp = requests.request(
                method=self.command,
                url=target_url,
                headers=forward_headers,
                data=body,
                allow_redirects=False,
                timeout=30
            )
            
            self.send_response(resp.status_code)
            for k, v in resp.headers.items():
                if k.lower() not in ['content-encoding', 'transfer-encoding', 'content-length', 'access-control-allow-origin']:
                    self.send_header(k, v)
            
            self.send_header('Content-Length', str(len(resp.content)))
            self.end_headers()
            self.wfile.write(resp.content)
        except Exception as e:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(f"Proxy error: {e}".encode('utf-8'))

    def _handle_proxy(self):
        if self.path.startswith('/api/huggingface'):
            self._proxy_request("https://huggingface.co/api", len("/api/huggingface"))
            return True
        elif self.path.startswith('/api/civitai'):
            self._proxy_request("https://civitai.red/api", len("/api/civitai"))
            return True
        elif self.path.startswith('/api/comfyui'):
            self._proxy_request("http://127.0.0.1:8188", len("/api/comfyui"))
            return True
        elif self.path.startswith('/api/ollama'):
            self._proxy_request("http://127.0.0.1:11434", len("/api/ollama"))
            return True
        # Proxy vaultwares-api routes to OVHCloud. Exact /api/jobs is served
        # locally so the browser dashboard can fall back when the API is down.
        elif self.path.startswith('/api/jobs/'):
            self._proxy_request(VAULTWARES_API, 0)
            return True
        elif self.path.startswith('/api/abort'):
            self._proxy_request(VAULTWARES_API, 0)
            return True
        return False

    def _handle_upscaler_status(self):
        """Check local Python upscaler availability."""
        models = get_available_upscale_models()
        available_models = [model["name"] for model in models]
        error = None
        cuda_available = False

        try:
            import importlib.util
            if importlib.util.find_spec("PIL") is None:
                error = "Pillow not installed (pip install pillow)"
            if NOMOS_MODEL_NAME in available_models and importlib.util.find_spec("spandrel") is None:
                error = "spandrel not installed (pip install spandrel)"
        except Exception as e:
            error = str(e)

        try:
            import torch
            cuda_available = torch.cuda.is_available()
        except Exception:
            pass

        available = bool(available_models and not error)
        result = {
            "available": available,
            "models": available_models,
            "model_details": models,
            "cuda": cuda_available
        }
        if error:
            result["error"] = error

        body = json.dumps(result).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def _handle_open_downloaded(self, data):
        """Open a downloaded file or the downloads folder locally."""
        import subprocess
        import os
        try:
            dest = os.path.abspath(DEST_DIR)
            if data.get('folder'):
                os.makedirs(dest, exist_ok=True)
                subprocess.run(['explorer', dest])
                result = {"status": "opened folder", "path": dest}
            else:
                filename = data.get('filename', '')
                filepath = os.path.join(dest, filename)
                if os.path.exists(filepath):
                    subprocess.run(['explorer', '/select,', os.path.normpath(filepath)])
                    result = {"status": "opened file", "path": os.path.normpath(filepath)}
                else:
                    result = {"status": "error", "error": f"File not found: {filename}", "path": os.path.normpath(filepath)}
            body = json.dumps(result).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self._handle_proxy():
            return
        if self.path == '/api/upscaler/status':
            self._handle_upscaler_status()
        elif self.path == '/api/jobs':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"jobs": get_jobs_snapshot(), "source": "local-python-zipper"}).encode('utf-8'))
        elif self.path in ['/', '/health', '/api']:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "online"}).encode('utf-8'))
        elif self.path == '/qa-logs':
            try:
                log_dir = os.path.join(DEST_DIR, '..', 'central-logs')
                logs = []
                if os.path.exists(log_dir):
                    for filename in os.listdir(log_dir):
                        if filename.endswith('.log'):
                            filepath = os.path.join(log_dir, filename)
                            with open(filepath, 'r', encoding='utf-8') as f:
                                for line in f:
                                    line = line.strip()
                                    if line:
                                        try:
                                            logs.append(json.loads(line))
                                        except:
                                            pass
                logs.sort(key=lambda x: x.get('timestamp', 0), reverse=True)
                logs = logs[:200]
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "ok", "logs": logs}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")

    def do_POST(self):
        if self._handle_proxy():
            return
        if self.path == '/scrape':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                url = data.get('url')
                selector = data.get('selector', '')
                patchright = data.get('patchright', False)
                batch_size = data.get('batch_size', 100)
                
                if not url:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"Missing url parameter")
                    return
                
                threading.Thread(target=self._run_scraper, args=(url, selector, patchright, batch_size)).start()
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "Scraping task started"}).encode('utf-8'))
            except Exception as e:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(f"Invalid JSON payload: {e}".encode('utf-8'))
                
        elif self.path == '/download':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                url = data.get('url')
                links = data.get('links', [])
                batch_size = data.get('batch_size', 100)
                upscale_enabled = bool(data.get('upscale_enabled', False))
                upscale_model = data.get('upscale_model', NOMOS_MODEL_NAME)
                
                if not url or not links:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"Missing url or links parameters")
                    return
                
                job_id = create_job(url, links, batch_size, upscale_enabled, upscale_model)
                threading.Thread(target=self._run_downloader, args=(job_id, url, links, batch_size, upscale_enabled, upscale_model)).start()
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "Download task started", "count": len(links), "correlationId": job_id}).encode('utf-8'))
            except Exception as e:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(f"Invalid JSON payload: {e}".encode('utf-8'))
                
        elif self.path == '/logs':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                
                log_dir = os.path.join(DEST_DIR, '..', 'central-logs')
                os.makedirs(log_dir, exist_ok=True)
                
                node = data.get('node', 'unknown_node')
                log_file_path = os.path.join(log_dir, f"{node}.log")
                
                with open(log_file_path, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(data) + "\n")
                    
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "Log received"}).encode('utf-8'))
            except Exception as e:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(f"Invalid JSON payload: {e}".encode('utf-8'))
        elif self.path == '/api/open-downloaded':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8')) if content_length > 0 else {}
            except Exception:
                data = {}
            self._handle_open_downloaded(data)
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Endpoint not found")

    def _run_scraper(self, url, selector, patchright, batch_size):
        print(f"\n[Server] Background scraper task started for URL: {url}")
        os.makedirs(DEST_DIR, exist_ok=True)
        if patchright:
            urls = scraper.scrape_with_patchright(url, selector)
        else:
            urls = scraper.scrape_with_requests(url, selector)
            
        if not urls:
            print(f"[Server] No image URLs found for: {url}")
            return
            
        self._download_and_process(url, urls, batch_size)

    def _run_downloader(self, job_id, url, links, batch_size, upscale_enabled=False, upscale_model=NOMOS_MODEL_NAME):
        print(f"\n[Server] Background downloader task started for URL: {url} ({len(links)} links)")
        os.makedirs(DEST_DIR, exist_ok=True)
        update_job(job_id, status="running")
        try:
            result = self._download_and_process(url, links, batch_size, upscale_enabled, upscale_model, job_id)
            complete_job(
                job_id,
                archives=result.get("archives", []),
                rclone_complete=result.get("rclone_complete", False),
            )
        except Exception as e:
            fail_job(job_id, e)
            raise

    def _download_and_process(self, page_url, raw_links, batch_size, upscale_enabled=False, upscale_model=NOMOS_MODEL_NAME, job_id=None):
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        url_slug = scraper.get_url_slug(page_url)
        rd_token = get_rd_token()
        
        # De-duplicate links
        unique_urls = []
        seen = set()
        for u in raw_links:
            full_url = urljoin(page_url, u)
            if (full_url.startswith("http://") or full_url.startswith("https://")) and full_url not in seen:
                seen.add(full_url)
                unique_urls.append(full_url)

        print(f"[Server] Processing {len(unique_urls)} link(s)...")
        update_job(job_id, total_links=len(unique_urls), status="running")

        image_urls = []
        archives = []
        rclone_results = []
        
        for index, url in enumerate(unique_urls, start=1):
            # 1. Bypass shorteners
            resolved_url = url
            if any(domain in url.lower() for domain in ["linkvertise.com", "direct-link.net", "link-center.net", "link-hub.net", "link-target.net"]):
                resolved_url = bypass_linkvertise(url)
                print(f"[Server] Bypassed {url} -> {resolved_url}")

            # 2. Unrestrict premium hosts
            final_url = resolved_url
            is_premium = any(domain in resolved_url.lower() for domain in [
                "mega.nz", "keep2share.cc", "k2s.cc", "fileboom.me", "fboom.me",
                "rapidgator.net", "rg.to", "katfile.com", "tezfiles.com", "pixeldrain.com"
            ])
            if is_premium:
                final_url = unrestrict_link_rd(resolved_url, rd_token)
                print(f"[Server] Unrestricted {resolved_url} -> {final_url}")

            # 3. Determine if it's an image or other file
            parsed = urlparse(final_url)
            ext = os.path.splitext(parsed.path)[1].lower().strip(".")
            
            is_image = ext in IMAGE_EXTENSIONS
            
            if is_image:
                image_urls.append(final_url)
            else:
                direct_result = self._download_direct_file(final_url, headers)
                if direct_result.get("filename"):
                    archives.append(direct_result["filename"])
                    rclone_results.append(direct_result.get("rclone_complete", False))
            update_job(job_id, processed_links=index, images_count=len(image_urls))

        # Download and zip remaining image files in batches
        if image_urls:
            zip_result = self._download_and_zip_images(url_slug, page_url, image_urls, batch_size, headers, upscale_enabled, upscale_model)
            archives.extend(zip_result.get("archives", []))
            rclone_results.extend(zip_result.get("rclone_results", []))
            update_job(job_id, images_count=zip_result.get("images_count", len(image_urls)))

        return {
            "archives": archives,
            "rclone_complete": bool(rclone_results) and all(rclone_results),
        }

    def _download_via_ytdlp(self, url):
        try:
            print(f"[Server] Detected HLS/m3u8/streaming content. Downloading via yt-dlp: {url}")
            import hashlib
            h = hashlib.md5(url.encode()).hexdigest()[:8]
            outtmpl = os.path.join(DEST_DIR, f"video_{h}_%(title)s.%(ext)s")
            
            cmd = ["yt-dlp", "-o", outtmpl, "--no-warnings", url]
            print(f"[Server] Running command: {' '.join(cmd)}")
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
            
            if result.returncode == 0:
                for f in os.listdir(DEST_DIR):
                    if f.startswith(f"video_{h}_"):
                        file_path = os.path.join(DEST_DIR, f)
                        print(f"[Server] Completed yt-dlp download: {f}")
                        rclone_complete = handoff_to_rclone(file_path)
                        return {"filename": f, "rclone_complete": rclone_complete}
                print(f"[Server] yt-dlp completed successfully but could not locate file starting with video_{h}_ in {DEST_DIR}")
            else:
                print(f"[Server] yt-dlp failed: {result.stderr}")
        except FileNotFoundError:
            print("[Server] yt-dlp executable was not found. Please install it.")
        except Exception as e:
            print(f"[Server] Error during yt-dlp execution: {e}")
        return {}

    def _download_direct_file(self, url, headers):
        # Detect HLS/m3u8 playlist URLs
        is_m3u8 = ".m3u8" in url.lower() or "hls" in url.lower()
        if is_m3u8:
            return self._download_via_ytdlp(url)

        try:
            print(f"[Server] Starting direct download for: {url}")
            resp = requests.get(url, headers=headers, stream=True, timeout=120)
            if resp.status_code != 200:
                print(f"[Server] Direct download failed for {url}: status {resp.status_code}")
                # Try falling back to yt-dlp just in case it's a video stream page
                return self._download_via_ytdlp(url)
                
            content_disp = resp.headers.get('content-disposition', '')
            filename = ""
            if 'filename=' in content_disp:
                filename = content_disp.split('filename=')[1].strip('"\'')
            
            if not filename:
                parsed = urlparse(url)
                filename = os.path.basename(parsed.path)
                
            if not filename:
                import hashlib
                filename = f"download_{hashlib.md5(url.encode()).hexdigest()[:8]}.bin"

            # Clean filename
            filename = re.sub(r'[<>:"/\\|?*]', '_', filename)
            
            file_path = os.path.join(DEST_DIR, filename)
            
            print(f"[Server] Saving to: {file_path}")
            with open(file_path, 'wb') as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
            print(f"[Server] Completed download: {filename}")
            rclone_complete = handoff_to_rclone(file_path)
            return {"filename": filename, "rclone_complete": rclone_complete}
        except Exception as e:
            print(f"[Server] Error downloading {url}: {e}")
            return self._download_via_ytdlp(url)

    def _download_and_zip_images(self, url_slug, page_url, img_urls, batch_size, headers, upscale_enabled=False, upscale_model=NOMOS_MODEL_NAME):
        zip_writer = None
        zip_path = None
        count = 0
        zip_file_count = 0
        archives = []
        rclone_results = []
        
        print(f"[Server] Downloading {len(img_urls)} images for slug '{url_slug}'...")

        for i, img_url in enumerate(img_urls):
            parsed_img = urlparse(img_url)
            ext = os.path.splitext(parsed_img.path)[1].lower().strip(".")
            if ext not in IMAGE_EXTENSIONS:
                ext = "jpg"

            content = scraper.download_image(img_url, headers)
            if not content:
                continue

            if upscale_enabled:
                content = upscale_image_content(content, ext, upscale_model)

            if zip_writer is None:
                random_suffix = random.randint(0, 9000)
                zip_filename = f"{url_slug}_{random_suffix}.zip"
                zip_path = os.path.join(DEST_DIR, zip_filename)
                zip_writer = zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED)
                zip_file_count += 1

            filename_in_zip = f"{url_slug}_{str(count + 1).zfill(3)}.{ext}"
            try:
                zip_writer.writestr(filename_in_zip, content)
                count += 1
            except Exception as e:
                print(f"[Server] Failed to write to zip: {e}")

            if count > 0 and count % batch_size == 0:
                zip_writer.close()
                archives.append(os.path.basename(zip_path))
                rclone_results.append(handoff_to_rclone(zip_path))
                zip_writer = None
                print(f"[Server] Closed zip: {zip_path}")
                count = 0

        if zip_writer is not None:
            zip_writer.close()
            archives.append(os.path.basename(zip_path))
            rclone_results.append(handoff_to_rclone(zip_path))
            print(f"[Server] Closed final zip: {zip_path}")

        print(f"[Server] Finished downloading and zipping task for: {page_url}")
        return {
            "archives": archives,
            "images_count": len(img_urls),
            "rclone_results": rclone_results,
        }

class ThreadedHTTPServer(ThreadingTCPServer):
    allow_reuse_address = True

def run_server():
    server = ThreadedHTTPServer(('0.0.0.0', PORT), ScraperHandler)
    print(f"Dataset Builder Local HTTP Server running on http://0.0.0.0:{PORT} ...")
    server.serve_forever()

if __name__ == '__main__':
    run_server()
