import os
import sys
import json
import threading
import requests
from urllib.parse import urljoin
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingTCPServer

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import scraper
from ds_jobs import (
    create_job, create_stream_job, delete_job, update_job, complete_job, fail_job,
    get_jobs_snapshot, JOBS, JOBS_LOCK,
)
from ds_helpers import (
    get_available_upscale_models, handoff_to_rclone, upscale_image_content,
    get_rd_token, unrestrict_link_rd, bypass_linkvertise,
    download_via_ytdlp, download_direct_file, download_and_zip_images,
    NOMOS_MODEL_NAME, IMAGE_EXTENSIONS,
)
from ds_streams import probe_stream, download_stream, stop_stream, STREAMS_DIR

PORT = 5171
DEST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".downloaded")
VAULTWARES_API = os.environ.get("VAULTWARES_API_URL", "https://api.vaultwares.ca:9001")


class ScraperHandler(BaseHTTPRequestHandler):
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
        subpath = self.path[prefix_len:]
        target_url = target_base_url.rstrip('/') + '/' + subpath.lstrip('/')
        if self.headers.get('Query-String'):
            target_url += "?" + self.headers.get('Query-String')
        forward_headers = {k: v for k, v in self.headers.items() if k.lower() not in ['host', 'content-length']}
        try:
            resp = requests.request(
                method=self.command, url=target_url, headers=forward_headers,
                data=body, allow_redirects=False, timeout=30
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
        elif self.path.startswith('/api/jobs/'):
            self._proxy_request(VAULTWARES_API, 0)
            return True
        elif self.path.startswith('/api/abort'):
            self._proxy_request(VAULTWARES_API, 0)
            return True
        return False

    def _handle_upscaler_status(self):
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

    def _read_json(self):
        length = int(self.headers.get('Content-Length', 0))
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception:
            return {}

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def _reveal_in_explorer(self, path, select=False):
        import subprocess
        p = os.path.normpath(os.path.abspath(path))
        try:
            if select and os.path.isfile(p):
                subprocess.Popen(f'explorer /select,"{p}"', shell=True)
            else:
                target_dir = p if os.path.isdir(p) else os.path.dirname(p)
                if not os.path.exists(target_dir):
                    target_dir = os.path.abspath(DEST_DIR)
                try:
                    os.startfile(target_dir)
                except Exception:
                    subprocess.Popen(f'explorer "{target_dir}"', shell=True)
        except Exception as e:
            print(f"[Server] reveal explorer failed: {e}")
        return p

    def _handle_open_downloaded(self, data):
        try:
            dest = os.path.abspath(DEST_DIR)
            os.makedirs(dest, exist_ok=True)
            os.makedirs(STREAMS_DIR, exist_ok=True)

            abs_path = data.get('path')
            if abs_path:
                p = os.path.normpath(os.path.abspath(abs_path))
                if os.path.exists(p):
                    self._reveal_in_explorer(p, select=os.path.isfile(p))
                    self._send_json({"ok": True, "status": "opened file" if os.path.isfile(p) else "opened folder", "path": p})
                else:
                    curr = p
                    while curr and not os.path.exists(curr):
                        parent = os.path.dirname(curr)
                        if parent == curr:
                            break
                        curr = parent
                    if not curr or not os.path.exists(curr):
                        curr = STREAMS_DIR if 'streams' in p.lower() else dest
                    self._reveal_in_explorer(curr, select=False)
                    self._send_json({"ok": True, "status": "opened folder", "path": curr})
                return

            if data.get('folder'):
                target = STREAMS_DIR if data.get('which') == 'streams' else dest
                self._reveal_in_explorer(target, select=False)
                self._send_json({"ok": True, "status": "opened folder", "path": target})
            else:
                filename = data.get('filename', '')
                filepath = os.path.normpath(os.path.join(dest, filename)) if filename else dest
                if os.path.exists(filepath):
                    self._reveal_in_explorer(filepath, select=os.path.isfile(filepath))
                    self._send_json({"ok": True, "status": "opened file" if os.path.isfile(filepath) else "opened folder", "path": filepath})
                else:
                    self._reveal_in_explorer(dest, select=False)
                    self._send_json({"ok": True, "status": "opened folder", "path": dest})
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self._handle_proxy():
            return
        if self.path.startswith('/api/download-file'):
            from urllib.parse import parse_qs, urlparse
            query = parse_qs(urlparse(self.path).query)
            filepath = query.get('path', [''])[0]
            if filepath:
                if not os.path.isabs(filepath):
                    filepath = os.path.normpath(os.path.join(DEST_DIR, filepath))
                if os.path.exists(filepath):
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(os.path.getsize(filepath)))
                    self.send_header('Content-Disposition', f'attachment; filename="{os.path.basename(filepath)}"')
                    self.end_headers()
                    with open(filepath, 'rb') as f:
                        while True:
                            chunk = f.read(1024 * 1024)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                    return
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"File not found")
            return
        elif self.path == '/api/upscaler/status':
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
                stream_headers = data.get('stream_headers', {}) or {}
                if not url or not links:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"Missing url or links parameters")
                    return
                job_id = create_job(url, links, batch_size, upscale_enabled, upscale_model)
                rclone_enabled = bool(data.get('rclone_enabled', False))
                threading.Thread(target=self._run_downloader, args=(job_id, url, links, batch_size, upscale_enabled, upscale_model, stream_headers, rclone_enabled)).start()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "Download task started", "count": len(links), "correlationId": job_id}).encode('utf-8'))
            except Exception as e:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(f"Invalid JSON payload: {e}".encode('utf-8'))
        elif self.path == '/api/stream/probe':
            data = self._read_json()
            url = data.get('url')
            if not url:
                self._send_json({"ok": False, "error": "missing url"}, 400)
                return
            self._send_json(probe_stream(url, data.get('headers') or {}, data.get('proxy')))
        elif self.path == '/api/stream/start':
            data = self._read_json()
            url = data.get('url')
            if not url:
                self._send_json({"ok": False, "error": "missing url"}, 400)
                return
            os.makedirs(DEST_DIR, exist_ok=True)
            job_id = create_stream_job(
                url, page_url=data.get('page_url'), title=data.get('title'),
                quality=data.get('quality'), thumbnail=data.get('thumbnail'),
                duration=data.get('duration'), is_live=data.get('is_live', False),
            )
            threading.Thread(
                target=download_stream,
                args=(job_id, url, data.get('headers') or {}, data.get('format_id'), data.get('proxy')),
                daemon=True,
            ).start()
            self._send_json({"ok": True, "status": "stream download started", "correlationId": job_id})
        elif self.path == '/api/stream/stop':
            data = self._read_json()
            stopped = stop_stream(data.get('job_id'))
            self._send_json({"ok": True, "stopped": stopped})
        elif self.path == '/api/stream/delete':
            data = self._read_json()
            job_id = data.get('job_id')
            stop_stream(job_id)
            self._send_json({"ok": True, "deleted": delete_job(job_id)})
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

    def _run_downloader(self, job_id, url, links, batch_size, upscale_enabled=False, upscale_model=NOMOS_MODEL_NAME, stream_headers=None, rclone_enabled=False):
        print(f"\n[Server] Background downloader task started for URL: {url} ({len(links)} links)")
        os.makedirs(DEST_DIR, exist_ok=True)
        update_job(job_id, status="running")
        try:
            result = self._download_and_process(url, links, batch_size, upscale_enabled, upscale_model, job_id, stream_headers, rclone_enabled)
            complete_job(
                job_id,
                archives=result.get("archives", []),
                rclone_complete=result.get("rclone_complete", False),
            )
        except Exception as e:
            fail_job(job_id, e)
            raise

    def _download_and_process(self, page_url, raw_links, batch_size, upscale_enabled=False, upscale_model=NOMOS_MODEL_NAME, job_id=None, stream_headers=None, rclone_enabled=False):
        from urllib.parse import urlparse
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        # Merge browser-captured headers (Referer/Cookie/User-Agent/Origin) from the
        # extension so authenticated streams resolve instead of 403'ing. These apply
        # to every link in the batch — the extension sends one stream per request.
        if stream_headers:
            for k, v in stream_headers.items():
                if v:
                    headers[k] = v
        url_slug = scraper.get_url_slug(page_url)
        rd_token = get_rd_token()
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
            resolved_url = url
            if any(domain in url.lower() for domain in ["linkvertise.com", "direct-link.net", "link-center.net", "link-hub.net", "link-target.net"]):
                resolved_url = bypass_linkvertise(url)
                print(f"[Server] Bypassed {url} -> {resolved_url}")
            final_url = resolved_url
            is_premium = any(domain in resolved_url.lower() for domain in [
                "mega.nz", "keep2share.cc", "k2s.cc", "fileboom.me", "fboom.me",
                "rapidgator.net", "rg.to", "katfile.com", "tezfiles.com", "pixeldrain.com"
            ])
            if is_premium:
                final_url = unrestrict_link_rd(resolved_url, rd_token)
                print(f"[Server] Unrestricted {resolved_url} -> {final_url}")
            parsed = urlparse(final_url)
            ext = os.path.splitext(parsed.path)[1].lower().strip(".")
            is_image = ext in IMAGE_EXTENSIONS
            if is_image:
                image_urls.append(final_url)
            else:
                direct_result = download_direct_file(final_url, headers, DEST_DIR, rclone_enabled)
                if direct_result.get("filename"):
                    archives.append(direct_result["filename"])
                    rclone_results.append(direct_result.get("rclone_complete", False))
            update_job(job_id, processed_links=index, images_count=len(image_urls))
        if image_urls:
            if len(image_urls) == 1 and not upscale_enabled:
                direct_result = download_direct_file(image_urls[0], headers, DEST_DIR, rclone_enabled)
                if direct_result.get("filename"):
                    archives.append(direct_result["filename"])
                    rclone_results.append(direct_result.get("rclone_complete", False))
            else:
                zip_result = download_and_zip_images(
                    url_slug, page_url, image_urls, batch_size, headers,
                    upscale_enabled, upscale_model, DEST_DIR, scraper.download_image,
                    rclone_enabled
                )
                archives.extend(zip_result.get("archives", []))
                rclone_results.extend(zip_result.get("rclone_results", []))
                update_job(job_id, images_count=zip_result.get("images_count", len(image_urls)))
        return {
            "archives": archives,
            "rclone_complete": bool(rclone_results) and all(rclone_results),
        }


class ThreadedHTTPServer(ThreadingTCPServer):
    allow_reuse_address = True

def run_server():
    bind_host = os.environ.get("BIND_HOST", "127.0.0.1")
    server = ThreadedHTTPServer((bind_host, PORT), ScraperHandler)
    print(f"Dataset Builder Local HTTP Server running on http://{bind_host}:{PORT} ...")
    server.serve_forever()

if __name__ == '__main__':
    run_server()