import os
import sys
import json
import threading
import datetime
import builtins
import requests
from urllib.parse import urljoin
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingTCPServer

# Force unbuffered / line-buffered stdout and stderr for service logs
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(line_buffering=True)
    except Exception:
        pass

# Universal timestamped logging wrapper
_orig_print = builtins.print
def timestamped_print(*args, **kwargs):
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if args:
        first = f"[{now}] {args[0]}"
        _orig_print(first, *args[1:], **kwargs)
    else:
        _orig_print(f"[{now}]", **kwargs)
    if "flush" not in kwargs:
        kwargs["flush"] = True
builtins.print = timestamped_print

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import scraper
from ds_jobs import (
    create_job, create_stream_job, delete_job, update_job, complete_job, fail_job,
    get_jobs_snapshot, JOBS, JOBS_LOCK,
)
from ds_helpers import (
    get_available_upscale_models, check_upscaler_capabilities, handoff_to_rclone, upscale_image_content,
    get_rd_token, unrestrict_link_rd, bypass_linkvertise,
    download_via_ytdlp, download_direct_file, download_and_zip_images,
    NOMOS_MODEL_NAME, IMAGE_EXTENSIONS,
)
from ds_streams import probe_stream, download_stream, stop_stream, STREAMS_DIR


def build_jobs_payload():
    return {
        "jobs": get_jobs_snapshot(),
        "source": "local-python-zipper",
        "download_dir": os.path.abspath(DEST_DIR),
        "streams_dir": os.path.abspath(STREAMS_DIR),
    }


def resolve_archive_paths(archives):
    return [os.path.abspath(os.path.join(DEST_DIR, name)) for name in archives]


def resolve_legacy_reveal_path(data):
    """Resolve v1.32 reveal input without performing a desktop side effect."""
    if data.get("path"):
        path = os.path.normpath(os.path.abspath(data["path"]))
    elif data.get("folder"):
        path = os.path.abspath(STREAMS_DIR if data.get("which") == "streams" else DEST_DIR)
    elif data.get("filename"):
        path = os.path.normpath(os.path.abspath(os.path.join(DEST_DIR, data["filename"])))
    else:
        raise ValueError("A path, filename, or folder request is required")
    if not os.path.exists(path):
        raise FileNotFoundError("The requested path does not exist")
    return path


PORT = 5171
from ds_config import DEST_DIR
VAULTWARES_API = os.environ.get("VAULTWARES_API_URL", "https://api.vaultwares.ca:9001")


class ScraperHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True
        except Exception as e:
            if "10053" in str(e) or "10054" in str(e) or "Broken pipe" in str(e):
                self.close_connection = True
            else:
                raise

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
        result = check_upscaler_capabilities()
        self._send_json(result)

    def _read_json(self):
        length = int(self.headers.get('Content-Length', 0))
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception:
            return {}

    def _send_json(self, obj, code=200):
        try:
            body = json.dumps(obj).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True
        except Exception as e:
            if "10053" in str(e) or "10054" in str(e) or "Broken pipe" in str(e):
                self.close_connection = True
            else:
                print(f"[Server] Error sending JSON: {e}")


    def do_OPTIONS(self):
        try:
            self.send_response(200)
            self.end_headers()
        except Exception:
            self.close_connection = True

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
                    try:
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
                    except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                        self.close_connection = True
                        return
                    except Exception as e:
                        if "10053" in str(e) or "10054" in str(e):
                            self.close_connection = True
                            return
            try:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"File not found")
            except Exception:
                self.close_connection = True
            return
        elif self.path == '/api/upscaler/status':
            self._handle_upscaler_status()
        elif self.path == '/api/jobs':
            self._send_json(build_jobs_payload())
        elif self.path in ['/', '/health', '/api']:
            self._send_json({"status": "online"})
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
                self._send_json({"status": "ok", "logs": logs})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
        else:
            try:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Not Found")
            except Exception:
                self.close_connection = True

    def do_POST(self):
        if self._handle_proxy():
            return
        if self.path == '/scrape':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length) if content_length > 0 else b""
            try:
                data = json.loads(post_data.decode('utf-8'))
                url = data.get('url')
                selector = data.get('selector', '')
                patchright = data.get('patchright', False)
                batch_size = data.get('batch_size', 100)
                if not url:
                    self._send_json({"error": "Missing url parameter"}, 400)
                    return
                threading.Thread(target=self._run_scraper, args=(url, selector, patchright, batch_size)).start()
                self._send_json({"status": "Scraping task started"})
            except Exception as e:
                self._send_json({"error": f"Invalid JSON payload: {e}"}, 400)
        elif self.path == '/download':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length) if content_length > 0 else b""
            try:
                data = json.loads(post_data.decode('utf-8'))
                url = data.get('url')
                links = data.get('links', [])
                batch_size = data.get('batch_size', 100)
                upscale_enabled = bool(data.get('upscale_enabled', False))
                upscale_model = data.get('upscale_model', NOMOS_MODEL_NAME)
                stream_headers = data.get('stream_headers', {}) or {}
                link_kinds = data.get('link_kinds', {}) or {}
                if not url or not links:
                    self._send_json({"error": "Missing url or links parameters"}, 400)
                    return
                job_id = create_job(url, links, batch_size, upscale_enabled, upscale_model)
                rclone_enabled = bool(data.get('rclone_enabled', False))
                threading.Thread(target=self._run_downloader, args=(job_id, url, links, batch_size, upscale_enabled, upscale_model, stream_headers, rclone_enabled, link_kinds)).start()
                self._send_json({"status": "Download task started", "count": len(links), "correlationId": job_id})
            except Exception as e:
                self._send_json({"error": f"Invalid JSON payload: {e}"}, 400)
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
                self._send_json({"status": "Log received"})
            except Exception as e:
                self._send_json({"error": f"Invalid JSON payload: {e}"}, 400)
        elif self.path == '/api/open-downloaded':
            # Compatibility bridge for signed extension v1.32. This resolves
            # paths only; Firefox native messaging performs the desktop action.
            data = self._read_json()
            try:
                path = resolve_legacy_reveal_path(data)
                self._send_json({"ok": True, "status": "resolved", "path": path})
            except (ValueError, FileNotFoundError) as exc:
                self._send_json({"ok": False, "error": str(exc)}, 404)
        else:
            try:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Endpoint not found")
            except Exception:
                self.close_connection = True

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

    def _run_downloader(self, job_id, url, links, batch_size, upscale_enabled=False, upscale_model=NOMOS_MODEL_NAME, stream_headers=None, rclone_enabled=False, link_kinds=None):
        print(f"\n[Server] Background downloader task started for URL: {url} ({len(links)} links)")
        os.makedirs(DEST_DIR, exist_ok=True)
        update_job(job_id, status="running")
        try:
            result = self._download_and_process(url, links, batch_size, upscale_enabled, upscale_model, job_id, stream_headers, rclone_enabled, link_kinds)
            archives = result.get("archives", [])
            update_job(job_id, save_dir=os.path.abspath(DEST_DIR), archive_paths=resolve_archive_paths(archives))
            complete_job(
                job_id,
                archives=archives,
                rclone_complete=result.get("rclone_complete", False),
            )
        except Exception as e:
            fail_job(job_id, e)
            raise

    def _download_and_process(self, page_url, raw_links, batch_size, upscale_enabled=False, upscale_model=NOMOS_MODEL_NAME, job_id=None, stream_headers=None, rclone_enabled=False, link_kinds=None):
        # Kept so the legacy /download route keeps working while the extension
        # migrates to the API. Both paths run the one pipeline.
        from ds_pipeline import download_and_process
        return download_and_process(
            page_url, raw_links, batch_size, upscale_enabled, upscale_model,
            job_id, stream_headers, rclone_enabled, link_kinds,
        )


class ThreadedHTTPServer(ThreadingTCPServer):
    allow_reuse_address = True


def run_server():
    bind_host = os.environ.get("BIND_HOST", "127.0.0.1")
    server = ThreadedHTTPServer((bind_host, PORT), ScraperHandler)
    print(f"Dataset Builder Local HTTP Server running on http://{bind_host}:{PORT} ...")
    server.serve_forever()

if __name__ == '__main__':
    run_server()
