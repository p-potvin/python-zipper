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

VAULT_COMMANDER_ROOT = r"C:\Users\Administrator\Desktop\Github Repos\vault-commander"
VAULT_COMMANDER_UPSCALERS_DIR = os.path.join(VAULT_COMMANDER_ROOT, "cli", "utils", "models", "upscalers")
VAULT_COMMANDER_PYTHON = os.path.join(VAULT_COMMANDER_ROOT, "cli", "utils", ".venv", "Scripts", "python.exe")
VAULT_COMMANDER_UPSCALE_SCRIPT = os.path.join(VAULT_COMMANDER_ROOT, "cli", "utils", "upscale.py")
VAULT_COMMANDER_ENHANCE_SCRIPT = os.path.join(VAULT_COMMANDER_ROOT, "cli", "Enhance-Image.ps1")

ENHANCE_OPERATIONS = [
    {
        "name": "magick-enhance",
        "label": "Auto Enhance — Denoise + Level + Sharpen",
        "group": "Enhancement",
        "kind": "magick",
        "op": "enhance",
        "desc": "Balanced general enhancement combining gentle despeckle, auto-level color balance, and unsharp mask"
    },
    {
        "name": "magick-sharpen",
        "label": "Sharpen — Unsharp Mask",
        "group": "Enhancement",
        "kind": "magick",
        "op": "sharpen",
        "desc": "High quality unsharp mask for edge clarity and crisp details"
    },
    {
        "name": "magick-denoise",
        "label": "Denoise — 3x3 Median Filter",
        "group": "Enhancement",
        "kind": "magick",
        "op": "denoise",
        "desc": "3x3 median noise reduction for clean grain removal"
    },
    {
        "name": "magick-contrast",
        "label": "Contrast — Sigmoidal Curve",
        "group": "Enhancement",
        "kind": "magick",
        "op": "contrast",
        "desc": "Sigmoidal non-linear contrast enhancement for rich depth"
    },
    {
        "name": "magick-autolevel",
        "label": "Auto Level — Dynamic Range",
        "group": "Enhancement",
        "kind": "magick",
        "op": "auto-level",
        "desc": "Channel-wise contrast stretch for perfect highlights/shadows"
    },
    {
        "name": "magick-clarity",
        "label": "Clarity — Local Micro-Contrast",
        "group": "Enhancement",
        "kind": "magick",
        "op": "clarity",
        "desc": "Local contrast adjustment for vivid texture definition"
    },
    {
        "name": "magick-vibrance",
        "label": "Vibrance — Color Saturation",
        "group": "Enhancement",
        "kind": "magick",
        "op": "vibrance",
        "desc": "Intelligent color boost preserving skin tones"
    }
]

UPSCALE_LABELS = {
    "4xNomos8k_atd": {
        "label": "4x Nomos8k ATD — AI High-Fidelity (Recommended)",
        "desc": "Trained for maximum fidelity on textures, skin, and fine details",
        "group": "Upscaling"
    },
    "4xNomos8kDAT": {
        "label": "4x Nomos8k DAT — AI Transformer Detail",
        "desc": "Transformer-based 4x upscaler with advanced attention mechanism",
        "group": "Upscaling"
    },
    "4xRealWebPhoto_v4_dat2": {
        "label": "4x RealWebPhoto v4 — AI Photo & Web",
        "desc": "Optimized specifically for web photos, portraits, and compressed JPEG artifacts",
        "group": "Upscaling"
    },
    "pillow-lanczos": {
        "label": "4x Fast Lanczos — Lightweight Resampling",
        "desc": "Fast CPU-based 4x Lanczos interpolation (no GPU required)",
        "group": "Upscaling"
    }
}


def get_available_upscale_models():
    """Discover all available upscaler models and enhancement operations."""
    models = []
    # 1. Scan vault-commander upscaler models
    if os.path.exists(VAULT_COMMANDER_UPSCALERS_DIR):
        for fname in sorted(os.listdir(VAULT_COMMANDER_UPSCALERS_DIR)):
            if fname.lower().endswith((".safetensors", ".pth", ".pt", ".bin")):
                name = os.path.splitext(fname)[0]
                meta = UPSCALE_LABELS.get(name, {
                    "label": f"4x {name} — AI Upscaling",
                    "desc": "Neural AI 4x Super-Resolution",
                    "group": "Upscaling"
                })
                models.append({
                    "name": name,
                    "label": meta["label"],
                    "desc": meta.get("desc", ""),
                    "group": meta.get("group", "Upscaling"),
                    "kind": "spandrel",
                    "path": os.path.abspath(os.path.join(VAULT_COMMANDER_UPSCALERS_DIR, fname)),
                })
    # 2. Add local models if present
    if os.path.exists(MODELS_DIR):
        for fname in sorted(os.listdir(MODELS_DIR)):
            if fname.lower().endswith((".safetensors", ".pth", ".pt")):
                name = os.path.splitext(fname)[0]
                if not any(m["name"] == name for m in models):
                    meta = UPSCALE_LABELS.get(name, {
                        "label": f"4x {name} — AI Upscaling",
                        "desc": "Neural AI 4x Super-Resolution",
                        "group": "Upscaling"
                    })
                    models.append({
                        "name": name,
                        "label": meta["label"],
                        "desc": meta.get("desc", ""),
                        "group": meta.get("group", "Upscaling"),
                        "kind": "spandrel",
                        "path": os.path.abspath(os.path.join(MODELS_DIR, fname)),
                    })
    # 3. Always include Pillow Lanczos
    p_meta = UPSCALE_LABELS["pillow-lanczos"]
    models.append({
        "name": "pillow-lanczos",
        "label": p_meta["label"],
        "desc": p_meta["desc"],
        "group": p_meta["group"],
        "kind": "pillow",
        "path": "",
    })
    # 4. Include ImageMagick enhancement operations
    for op in ENHANCE_OPERATIONS:
        models.append(op)
    return models


_CAPABILITIES_CACHE = None
_CAPABILITIES_LOCK = threading.Lock()
_UPSCALE_SEMAPHORE = threading.Semaphore(1)


def check_upscaler_capabilities(force_refresh=False):
    """Verify upscaler availability, CUDA support, and model discovery.
    Cached in-memory to prevent repeated heavy subprocess invocations."""
    global _CAPABILITIES_CACHE
    if _CAPABILITIES_CACHE is not None and not force_refresh:
        return _CAPABILITIES_CACHE

    with _CAPABILITIES_LOCK:
        if _CAPABILITIES_CACHE is not None and not force_refresh:
            return _CAPABILITIES_CACHE

        models = get_available_upscale_models()
        model_names = [m["name"] for m in models]
        has_vc_env = os.path.exists(VAULT_COMMANDER_PYTHON) and os.path.exists(VAULT_COMMANDER_UPSCALE_SCRIPT)
        cuda_available = False
        device_name = ""
        error = None

        if has_vc_env:
            # Check capabilities via vault-commander venv once and cache it
            try:
                cmd = [
                    VAULT_COMMANDER_PYTHON,
                    "-c",
                    "import torch, spandrel, PIL; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
                ]
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                if res.returncode == 0:
                    lines = res.stdout.strip().splitlines()
                    if len(lines) >= 1 and lines[0].strip().lower() == "true":
                        cuda_available = True
                    if len(lines) >= 2:
                        device_name = lines[1].strip()
                else:
                    error = res.stderr.strip()
            except Exception as e:
                error = str(e)
        else:
            # Fallback to current process venv
            try:
                import importlib.util
                if importlib.util.find_spec("PIL") is None:
                    error = "Pillow not installed"
                if importlib.util.find_spec("spandrel") is None and any(m.get("kind") == "spandrel" for m in models):
                    error = "spandrel not installed"
                import torch
                cuda_available = torch.cuda.is_available()
                if cuda_available:
                    device_name = torch.cuda.get_device_name(0)
            except Exception as e:
                if not error:
                    error = str(e)

        available = bool(len(model_names) > 0 and (has_vc_env or not error))
        _CAPABILITIES_CACHE = {
            "available": available,
            "models": model_names,
            "model_details": models,
            "cuda": cuda_available,
            "device": device_name or ("NVIDIA CUDA" if cuda_available else "CPU"),
            "error": error if not available else None
        }
        return _CAPABILITIES_CACHE


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
    if not model or model == "off":
        return content

    with _UPSCALE_SEMAPHORE:
        return _do_upscale_image_content(content, ext, model)


def _do_upscale_image_content(content, ext, model):
    # 1. ImageMagick / VW CLI quality enhancement operations
    magick_op = None
    if model.startswith("magick-"):
        magick_op = model.replace("magick-", "")
    elif model in ["enhance", "sharpen", "denoise", "contrast", "auto-level", "autolevel", "clarity", "vibrance"]:
        magick_op = model

    if magick_op:
        if magick_op in ["autolevel", "auto-level"]:
            magick_op = "auto-level"
        import tempfile
        tmp_in = None
        tmp_out = None
        try:
            clean_ext = ext.lstrip(".").lower()
            with tempfile.NamedTemporaryFile(suffix=f".{clean_ext}", delete=False) as f_in:
                f_in.write(content)
                tmp_in = f_in.name
            with tempfile.NamedTemporaryFile(suffix=f".{clean_ext}", delete=False) as f_out:
                tmp_out = f_out.name

            # Preferred: Execute via vault-commander CLI script
            if os.path.exists(VAULT_COMMANDER_ENHANCE_SCRIPT):
                cmd = [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy", "Bypass",
                    "-File", VAULT_COMMANDER_ENHANCE_SCRIPT,
                    "-InputPath", tmp_in,
                    "-Operation", magick_op,
                    "-OutputPath", tmp_out
                ]
            else:
                args = ["magick", tmp_in]
                if magick_op == "enhance":
                    args.extend(["-despeckle", "-auto-level", "-unsharp", "0x1.0+1.2+0.05"])
                elif magick_op == "sharpen":
                    args.extend(["-unsharp", "0x1.2+1.5+0.04"])
                elif magick_op == "denoise":
                    args.extend(["-statistic", "median", "3x3"])
                elif magick_op == "contrast":
                    args.extend(["-sigmoidal-contrast", "3,50%"])
                elif magick_op == "auto-level":
                    args.extend(["-auto-level"])
                elif magick_op == "clarity":
                    args.extend(["-unsharp", "0x5.0+0.8+0.0", "-auto-gamma"])
                elif magick_op == "vibrance":
                    args.extend(["-modulate", "100,120,100"])
                args.append(tmp_out)
                cmd = args

            res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if res.returncode == 0 and os.path.exists(tmp_out) and os.path.getsize(tmp_out) > 0:
                with open(tmp_out, "rb") as f:
                    return f.read()
            else:
                print(f"[Server] ImageMagick enhancement error ({res.returncode}): {res.stderr.strip() or res.stdout.strip()}")
        except Exception as e:
            print(f"[Server] ImageMagick enhancement exception: {e}")
        finally:
            if tmp_in and os.path.exists(tmp_in):
                try: os.remove(tmp_in)
                except Exception: pass
            if tmp_out and os.path.exists(tmp_out):
                try: os.remove(tmp_out)
                except Exception: pass

    # 2. Pillow Lanczos mode
    if model == "pillow-lanczos":
        try:
            import io
            from PIL import Image
            img = Image.open(io.BytesIO(content))
            new_w, new_h = img.width * 4, img.height * 4
            upscaled = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
            out_buf = io.BytesIO()
            fmt = "JPEG" if ext.lower() in ["jpg", "jpeg"] else ext.upper()
            upscaled.save(out_buf, format=fmt)
            return out_buf.getvalue()
        except Exception as e:
            print(f"[Server] Pillow Lanczos upscaling failed: {e}")
            return content

    # 3. Vault-commander CUDA Spandrel upscaling
    if os.path.exists(VAULT_COMMANDER_PYTHON) and os.path.exists(VAULT_COMMANDER_UPSCALE_SCRIPT):
        import tempfile
        tmp_in = None
        tmp_out = None
        try:
            clean_ext = ext.lstrip(".").lower()
            with tempfile.NamedTemporaryFile(suffix=f".{clean_ext}", delete=False) as f_in:
                f_in.write(content)
                tmp_in = f_in.name
            with tempfile.NamedTemporaryFile(suffix=f".{clean_ext}", delete=False) as f_out:
                tmp_out = f_out.name

            cmd = [
                VAULT_COMMANDER_PYTHON,
                VAULT_COMMANDER_UPSCALE_SCRIPT,
                "--input", tmp_in,
                "--model", model,
                "--output", tmp_out
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
            if res.returncode == 0 and os.path.exists(tmp_out) and os.path.getsize(tmp_out) > 0:
                with open(tmp_out, "rb") as f:
                    return f.read()
            else:
                print(f"[Server] Vault-commander upscaling exited ({res.returncode}): {res.stderr.strip() or res.stdout.strip()}")
        except Exception as e:
            print(f"[Server] Vault-commander upscaling exception: {e}")
        finally:
            if tmp_in and os.path.exists(tmp_in):
                try: os.remove(tmp_in)
                except Exception: pass
            if tmp_out and os.path.exists(tmp_out):
                try: os.remove(tmp_out)
                except Exception: pass

    # 4. Fallback local Python upscale
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


def download_via_ytdlp(url, dest_dir, headers=None, rclone_enabled=False):
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
                    rclone_complete = handoff_to_rclone(file_path) if rclone_enabled else False
                    return {"filename": f, "rclone_complete": rclone_complete}
            print(f"[Server] yt-dlp completed but could not locate file starting with video_{h}_ in {dest_dir}")
        else:
            print(f"[Server] yt-dlp failed: {result.stderr}")
    except FileNotFoundError:
        print("[Server] yt-dlp executable was not found. Please install it.")
    except Exception as e:
        print(f"[Server] Error during yt-dlp execution: {e}")
    return {}


def download_direct_file(url, headers, dest_dir, rclone_enabled=False):
    lower = url.lower()
    is_stream = (
        ".m3u8" in lower or ".mpd" in lower or ".f4m" in lower
        or ".ism/" in lower or "/manifest" in lower or "hls" in lower or "dash" in lower
    )
    if is_stream:
        return download_via_ytdlp(url, dest_dir, headers, rclone_enabled)
    try:
        print(f"[Server] Starting direct download for: {url}")
        try:
            resp = requests.get(url, headers=headers, stream=True, timeout=120)
        except requests.exceptions.ProxyError as pe:
            print(f"[Server] Proxy failed for {url} ({pe}), falling back to direct...")
            resp = requests.get(url, headers=headers, stream=True, timeout=120, proxies={"http": None, "https": None})
        if resp.status_code != 200:
            print(f"[Server] Direct download failed for {url}: status {resp.status_code}")
            return download_via_ytdlp(url, dest_dir, headers, rclone_enabled)
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
        rclone_complete = handoff_to_rclone(file_path) if rclone_enabled else False
        return {"filename": filename, "rclone_complete": rclone_complete}
    except Exception as e:
        print(f"[Server] Error downloading {url}: {e}")
        return download_via_ytdlp(url, dest_dir, headers, rclone_enabled)


def download_and_zip_images(url_slug, page_url, img_urls, batch_size, headers,
                            upscale_enabled=False, upscale_model=NOMOS_MODEL_NAME, dest_dir=None,
                            download_image_fn=None, rclone_enabled=False):
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
            rclone_results.append(handoff_to_rclone(zip_path) if rclone_enabled else False)
            zip_writer = None
            print(f"[Server] Closed zip: {zip_path}")
            count = 0

    if zip_writer is not None:
        zip_writer.close()
        archives.append(os.path.basename(zip_path))
        rclone_results.append(handoff_to_rclone(zip_path) if rclone_enabled else False)
        print(f"[Server] Closed final zip: {zip_path}")

    print(f"[Server] Finished downloading and zipping task for: {page_url}")
    return {
        "archives": archives,
        "images_count": len(img_urls),
        "rclone_results": rclone_results,
    }
