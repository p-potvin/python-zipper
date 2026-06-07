import os
import sys
import json
import random
import zipfile
import threading
from urllib.parse import urlparse, urljoin
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingTCPServer

# Add current folder to path to allow importing scraper
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import scraper

PORT = 5171
DEST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".downloaded")

class ScraperHandler(BaseHTTPRequestHandler):
    # Quiet server logging to avoid printing every request in console
    def log_message(self, format, *args):
        pass

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
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
            
        self._download_and_zip(url, urls, batch_size)

    def _run_downloader(self, url, links, batch_size):
        print(f"\n[Server] Background downloader task started for URL: {url} ({len(links)} links)")
        os.makedirs(DEST_DIR, exist_ok=True)
        self._download_and_zip(url, links, batch_size)

    def _download_and_zip(self, page_url, img_urls, batch_size):
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        url_slug = scraper.get_url_slug(page_url)
        zip_writer = None
        zip_path = None
        count = 0
        zip_file_count = 0
        
        # De-duplicate links
        unique_urls = []
        seen = set()
        for u in img_urls:
            full_url = urljoin(page_url, u)
            if (full_url.startswith("http://") or full_url.startswith("https://")) and full_url not in seen:
                seen.add(full_url)
                unique_urls.append(full_url)

        print(f"[Server] Downloading {len(unique_urls)} images for slug '{url_slug}'...")

        for i, img_url in enumerate(unique_urls):
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

            # Format file name using zfill
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
    server = ThreadedHTTPServer(('127.0.0.1', PORT), ScraperHandler)
    print(f"Dataset Builder Local HTTP Server running on http://127.0.0.1:{PORT} ...")
    server.serve_forever()

if __name__ == '__main__':
    run_server()
