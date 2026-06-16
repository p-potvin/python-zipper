import os
import sys
import json
import random
import zipfile
import threading
import re
import requests
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
VAULTWARES_API = os.environ.get("VAULTWARES_API_URL", "http://100.67.25.118:9001")
# Local upscaler models directory
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models")

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
        # Proxy vaultwares-api routes to OVHCloud
        elif self.path.startswith('/api/jobs') or self.path.startswith('/api/abort'):
            self._proxy_request(VAULTWARES_API, 0)
            return True
        return False

    def _handle_upscaler_status(self):
        """Check local upscaler availability (spandrel + model files)."""
        models_dir = os.path.abspath(MODELS_DIR)
        available_models = []
        error = None
        cuda_available = False

        try:
            import importlib.util
            if importlib.util.find_spec("spandrel") is None:
                error = "spandrel not installed (pip install spandrel)"
            else:
                if os.path.exists(models_dir):
                    for f in os.listdir(models_dir):
                        if f.lower().endswith(('.safetensors', '.pth', '.ckpt')):
                            available_models.append(os.path.splitext(f)[0])
                if not available_models:
                    error = f"No model files in {models_dir}"
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
        try:
            dest = os.path.abspath(DEST_DIR)
            if data.get('folder'):
                os.makedirs(dest, exist_ok=True)
                os.startfile(dest)
                result = {"status": "opened folder"}
            else:
                filename = data.get('filename', '')
                filepath = os.path.join(dest, filename)
                if os.path.exists(filepath):
                    os.startfile(filepath)
                    result = {"status": "opened file"}
                else:
                    result = {"status": "error", "error": f"File not found: {filename}"}
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
                playwright = data.get('playwright', False)
                batch_size = data.get('batch_size', 100)
                
                if not url:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"Missing url parameter")
                    return
                
                threading.Thread(target=self._run_scraper, args=(url, selector, playwright, batch_size)).start()
                
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
                
                if not url or not links:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"Missing url or links parameters")
                    return
                
                threading.Thread(target=self._run_downloader, args=(url, links, batch_size)).start()
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "Download task started", "count": len(links)}).encode('utf-8'))
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

    def _run_scraper(self, url, selector, playwright, batch_size):
        print(f"\n[Server] Background scraper task started for URL: {url}")
        os.makedirs(DEST_DIR, exist_ok=True)
        if playwright:
            urls = scraper.scrape_with_playwright(url, selector)
        else:
            urls = scraper.scrape_with_requests(url, selector)
            
        if not urls:
            print(f"[Server] No image URLs found for: {url}")
            return
            
        self._download_and_process(url, urls, batch_size)

    def _run_downloader(self, url, links, batch_size):
        print(f"\n[Server] Background downloader task started for URL: {url} ({len(links)} links)")
        os.makedirs(DEST_DIR, exist_ok=True)
        self._download_and_process(url, links, batch_size)

    def _download_and_process(self, page_url, raw_links, batch_size):
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

        image_urls = []
        
        for url in unique_urls:
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
            
            is_image = ext in ["jpg", "jpeg", "png", "gif", "webp", "svg"]
            
            if is_image:
                image_urls.append(final_url)
            else:
                # Save non-image file directly in background
                threading.Thread(target=self._download_direct_file, args=(final_url, headers)).start()

        # Download and zip remaining image files in batches
        if image_urls:
            self._download_and_zip_images(url_slug, page_url, image_urls, batch_size, headers)

    def _download_direct_file(self, url, headers):
        try:
            print(f"[Server] Starting direct download for: {url}")
            resp = requests.get(url, headers=headers, stream=True, timeout=120)
            if resp.status_code != 200:
                print(f"[Server] Direct download failed for {url}: status {resp.status_code}")
                return
                
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
        except Exception as e:
            print(f"[Server] Error downloading {url}: {e}")

    def _download_and_zip_images(self, url_slug, page_url, img_urls, batch_size, headers):
        zip_writer = None
        zip_path = None
        count = 0
        zip_file_count = 0
        
        print(f"[Server] Downloading {len(img_urls)} images for slug '{url_slug}'...")

        for i, img_url in enumerate(img_urls):
            parsed_img = urlparse(img_url)
            ext = os.path.splitext(parsed_img.path)[1].lower().strip(".")
            if ext not in ["jpg", "jpeg", "png", "gif", "webp", "svg"]:
                ext = "jpg"

            content = scraper.download_image(img_url, headers)
            if not content:
                continue

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
                zip_writer = None
                print(f"[Server] Closed zip: {zip_path}")
                count = 0

        if zip_writer is not None:
            zip_writer.close()
            print(f"[Server] Closed final zip: {zip_path}")

        print(f"[Server] Finished downloading and zipping task for: {page_url}")

class ThreadedHTTPServer(ThreadingTCPServer):
    allow_reuse_address = True

def run_server():
    server = ThreadedHTTPServer(('0.0.0.0', PORT), ScraperHandler)
    print(f"Dataset Builder Local HTTP Server running on http://0.0.0.0:{PORT} ...")
    server.serve_forever()

if __name__ == '__main__':
    run_server()
