"""
Helper functions extracted from dataset_builder/server.py.
Includes rclone handoff, upscaling, Real-Debrid token/unrestriction,
Linkvertise bypass, yt-dlp download, and direct file download.
"""

import os
import re
import sys
import random
import shutil
import subprocess
import requests
from urllib.parse import urlparse


def find_executable(name, env_var=None):
    """Locate a CLI robustly, independent of how the server was launched.

    The server runs as an NSSM Windows service, so it has a stripped PATH and a
    service-account %LOCALAPPDATA% that is NOT where winget installed yt-dlp/
    ffmpeg (those live under the interactive user's profile). Search: explicit
    env override -> PATH -> this account's WinGet dir -> EVERY user profile's
    WinGet dir -> the venv. Cached so the glob runs once.
    """
    import glob
    cache = find_executable._cache
    if name in cache:
        return cache[name]

    exe = name if name.lower().endswith(".exe") else name + ".exe"
    result = None

    if env_var:
        p = os.environ.get(env_var, "").strip()
        if p and os.path.exists(p):
            result = p
    if not result:
        result = shutil.which(name)
    if not result:
        candidates = []
        for base in (os.environ.get("LOCALAPPDATA", ""),
                     os.path.join(os.environ.get("USERPROFILE", ""), "AppData", "Local")):
            if base:
                candidates.append(os.path.join(base, "Microsoft", "WinGet", "Links", exe))
        # Any user profile — the service account may differ from the installer's.
        drive = os.environ.get("SystemDrive", "C:") + os.sep
        candidates += glob.glob(os.path.join(drive, "Users", "*", "AppData", "Local", "Microsoft", "WinGet", "Links", exe))
        candidates.append(os.path.join(os.path.dirname(sys.executable), exe))
        candidates.append(os.path.join(os.path.dirname(sys.executable), "Scripts", exe))
        for c in candidates:
            if c and os.path.exists(c):
                result = c
                break

    result = result or name  # last resort — clear FileNotFoundError
    cache[name] = result
    return result


find_executable._cache = {}


def ytdlp_bin():
    return find_executable("yt-dlp", "PYTHON_ZIPPER_YTDLP")


def ffmpeg_location():
    f = find_executable("ffmpeg", "PYTHON_ZIPPER_FFMPEG")
    return os.path.dirname(f) if f and os.path.exists(f) else None

MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models")
NOMOS_MODEL_NAME = "4xNomos8k_atd"
NOMOS_MODEL_PATH = os.path.join(MODELS_DIR, f"{NOMOS_MODEL_NAME}.safetensors")
DEFAULT_RCLONE_REMOTES = "gdrive:python-zipper,proton:python-zipper"
IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "gif", "webp", "svg"}
UPSCALE_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
RD_TOKEN_PATH = r"C:\Users\Administrator\Desktop\Github Repos\.access\realdebrid_api.txt"


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


def _configured_rclone_remotes():
    raw = os.environ.get("PYTHON_ZIPPER_RCLONE_REMOTES", DEFAULT_RCLONE_REMOTES)
    return [remote.strip() for remote in raw.split(",") if remote.strip()]


def handoff_to_rclone(file_path):
    if not file_path or not os.path.exists(file_path):
        return False
    for remote in _configured_rclone_remotes():
        destination = remote if remote.endswith(("/", ":")) else f"{remote}/"
        try:
            print(f"[Server] Moving completed download to rclone remote: {remote}")
            result = subprocess.run(
                ["rclone", "move", file_path, destination, "--create-empty-src-dirs"],
                capture_output=True, text=True, timeout=600,
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
            headers=headers, data={'link': url}, timeout=12
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


def build_ytdlp_header_args(headers):
    """Turn captured browser request headers into yt-dlp CLI args.

    User-Agent and Referer map to their dedicated flags; everything else
    (Cookie, Origin, ...) goes through --add-header "Field:Value". This is what
    lets yt-dlp fetch authenticated streams the browser could see but a bare
    server-side request gets 403'd on.
    """
    args = []
    if not headers:
        return args
    norm = {str(k).lower(): v for k, v in headers.items() if v}
    ua = norm.pop("user-agent", None)
    if ua:
        args += ["--user-agent", ua]
    ref = norm.pop("referer", None) or norm.pop("referrer", None)
    if ref:
        args += ["--referer", ref]
    for name, value in norm.items():
        proper = "-".join(part.capitalize() for part in name.split("-"))
        args += ["--add-header", f"{proper}:{value}"]
    return args


def download_via_ytdlp(url, dest_dir, headers=None):
    try:
        print(f"[Server] Detected HLS/m3u8/streaming content. Downloading via yt-dlp: {url}")
        import hashlib
        h = hashlib.md5(url.encode()).hexdigest()[:8]
        outtmpl = os.path.join(dest_dir, f"video_{h}_%(title)s.%(ext)s")
        cmd = [ytdlp_bin(), "-o", outtmpl, "--no-warnings"]
        ff = ffmpeg_location()
        if ff:
            cmd += ["--ffmpeg-location", ff]
        cmd += build_ytdlp_header_args(headers)
        cmd.append(url)
        print(f"[Server] Running command: {' '.join(cmd)}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if result.returncode == 0:
            for f in os.listdir(dest_dir):
                if f.startswith(f"video_{h}_"):
                    file_path = os.path.join(dest_dir, f)
                    print(f"[Server] Completed yt-dlp download: {f}")
                    rclone_complete = handoff_to_rclone(file_path)
                    return {"filename": f, "rclone_complete": rclone_complete}
            print(f"[Server] yt-dlp completed but could not locate file starting with video_{h}_ in {dest_dir}")
        else:
            print(f"[Server] yt-dlp failed: {result.stderr}")
    except FileNotFoundError:
        print("[Server] yt-dlp executable was not found. Please install it.")
    except Exception as e:
        print(f"[Server] Error during yt-dlp execution: {e}")
    return {}


def download_direct_file(url, headers, dest_dir):
    lower = url.lower()
    is_stream = (
        ".m3u8" in lower or ".mpd" in lower or ".f4m" in lower
        or ".ism/" in lower or "/manifest" in lower or "hls" in lower or "dash" in lower
    )
    if is_stream:
        return download_via_ytdlp(url, dest_dir, headers)
    try:
        print(f"[Server] Starting direct download for: {url}")
        resp = requests.get(url, headers=headers, stream=True, timeout=120)
        if resp.status_code != 200:
            print(f"[Server] Direct download failed for {url}: status {resp.status_code}")
            return download_via_ytdlp(url, dest_dir, headers)
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
        filename = re.sub(r'[<>:"/\\|?*]', '_', filename)
        file_path = os.path.join(dest_dir, filename)
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
        return download_via_ytdlp(url, dest_dir, headers)


def download_and_zip_images(url_slug, page_url, img_urls, batch_size, headers,
                            upscale_enabled=False, upscale_model=NOMOS_MODEL_NAME, dest_dir=None,
                            download_image_fn=None):
    import zipfile
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

        content = download_image_fn(img_url, headers) if download_image_fn else None
        if not content:
            continue

        if upscale_enabled:
            content = upscale_image_content(content, ext, upscale_model)

        if zip_writer is None:
            random_suffix = random.randint(0, 9000)
            zip_filename = f"{url_slug}_{random_suffix}.zip"
            zip_path = os.path.join(dest_dir, zip_filename)
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
