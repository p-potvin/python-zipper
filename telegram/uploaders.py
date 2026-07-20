"""
Uploaders module — all cloud storage upload functions and fallback orchestration.

Services (in fallback order):
  1. Gofile (local file)
  2. Pixeldrain (local file)
  3. 1fichier (local file)
  4. K2S/FileBoom (local file, via k2s_uploader)
  5. Katfile (remote stream or local file, 2GB daily quota — last resort)

Also includes:
  - register_mirror_in_link_sharing: registers uploaded URLs in Prom King Link Sharing API
  - get_katfile_daily_uploaded_size / can_upload_to_katfile: quota tracking
  - slugify: helper for URL slug generation
"""

import os
import re
import datetime
import requests


# ==============================================================================
# CONFIGURATION — these are set by telethon_link_resolver.py at import time
# ==============================================================================

KATFILE_API_KEY = ""
KATFILE_API_BASE = "https://katfile.space/api"
KATFILE_UPLOAD_SERVER_ENDPOINT = "https://katfile.space/api/upload/server"
KATFILE_DOMAIN = "https://katfile.space"
KATFILE_DAILY_LIMIT = 2 * 1024 * 1024 * 1024  # 2 GB

PIXELDRAIN_KEY = ""
ONEFICHIER_KEY = ""
GOFILE_KEY = ""

OUTPUT_DIR = ""


def configure(**kwargs):
    """Called by telethon_link_resolver.py to pass config values."""
    global KATFILE_API_KEY, KATFILE_API_BASE, KATFILE_UPLOAD_SERVER_ENDPOINT
    global KATFILE_DOMAIN, KATFILE_DAILY_LIMIT
    global PIXELDRAIN_KEY, ONEFICHIER_KEY, GOFILE_KEY
    global OUTPUT_DIR
    for k, v in kwargs.items():
        if k in globals():
            globals()[k] = v


# ==============================================================================
# HELPERS
# ==============================================================================

def slugify(text):
    text = text.lower()
    if '.' in text:
        text = '.'.join(text.split('.')[:-1])
    text = re.sub(r'[^a-z0-9_-]+', '-', text)
    text = re.sub(r'-+', '-', text)
    return text.strip('-')[:100]


def _log_upload(filename, file_size, service):
    """Append an upload record to uploads_log.txt."""
    log_file = os.path.join(OUTPUT_DIR, "uploads_log.txt")
    today = datetime.date.today().isoformat()
    with open(log_file, "a", encoding="utf-8") as lf:
        lf.write(f"[{today}] {filename} ({file_size / (1024**3):.4f} GB) -> {service} (local)\n")


# ==============================================================================
# LINK SHARING REGISTRATION
# ==============================================================================

def register_mirror_in_link_sharing(filename, remote_url):
    """Register a file and its mirror link in the Prom King Link Sharing service."""
    import uuid
    from urllib.parse import urlparse

    API_BASE_URL = os.environ.get("LINK_SHARING_API_URL", "https://api.vaultwares.ca")
    API_KEY = os.environ.get("LINK_SHARING_API_KEY", "dev-secret-key-123")

    headers = {"Authorization": f"Bearer {API_KEY}"}

    try:
        hosts_resp = requests.get(f"{API_BASE_URL}/api/hosts", headers=headers, timeout=3)
        if hosts_resp.status_code != 200:
            print(f"[Link Sharing] Failed to fetch hosts: {hosts_resp.status_code} {hosts_resp.text}")
            return None

        hosts = hosts_resp.json()
        domain = urlparse(remote_url).hostname
        if not domain:
            print(f"[Link Sharing] Invalid mirror URL: {remote_url}")
            return None
        domain = domain.lower().replace("www.", "")

        host_id = None
        for host in hosts:
            base_domain = host.get("baseDomain", "").lower()
            if base_domain in domain or domain in base_domain:
                host_id = host["id"]
                break

        if not host_id:
            keywords_mapping = {
                "katfile": ["katfile"],
                "keep2share": ["k2s", "keep2share"],
                "fileboom": ["fileboom", "fboom"],
                "rapidgator": ["rapidgator", "rg.to"]
            }
            for host in hosts:
                host_name_lower = host.get("name", "").lower()
                base_domain = host.get("baseDomain", "").lower()
                for key, kw_list in keywords_mapping.items():
                    if any(kw in domain for kw in kw_list):
                        if any(kw in host_name_lower or kw in base_domain for kw in kw_list):
                            host_id = host["id"]
                            break
                if host_id:
                    break

        if not host_id:
            print(f"[Link Sharing] No matching host found in DB for domain: {domain}")
            return None

        slug = f"{slugify(filename)}-{uuid.uuid4().hex[:6]}"

        payload = {
            "title": filename,
            "contentId": f"vid-{hash(filename) & 0xffffffff}",
            "slug": slug,
            "hostId": host_id,
            "remoteUrl": remote_url,
            "priority": 100
        }

        create_resp = requests.post(
            f"{API_BASE_URL}/api/routes/quick-create",
            headers=headers,
            json=payload,
            timeout=3
        )

        if create_resp.status_code in [200, 201]:
            result = create_resp.json()
            print(f"[Link Sharing] [OK] Registered mirror on {domain} -> {API_BASE_URL}/f/{result['slug']}")
            return result
        else:
            print(f"[Link Sharing] Failed to quick-create route: {create_resp.status_code} {create_resp.text}")
            return None

    except requests.exceptions.ConnectionError:
        print(f"[Link Sharing] [WARN] API at {API_BASE_URL} is unreachable. Skipping mirror registration.")
        return None
    except Exception as e:
        print(f"[Link Sharing] [ERROR] Exception registering mirror: {e}")
        return None


# ==============================================================================
# KATFILE QUOTA TRACKING
# ==============================================================================

def get_katfile_daily_uploaded_size():
    """Get total size of files already uploaded to Katfile today."""
    log_file = os.path.join(OUTPUT_DIR, "uploads_log.txt")
    if not os.path.exists(log_file):
        return 0

    today = datetime.date.today().isoformat()
    total_size = 0

    try:
        with open(log_file, 'r', encoding='utf-8') as f:
            for line in f:
                if today in line and 'katfile' in line.lower():
                    match = re.search(r'\(([\d.]+)\s*GB\)', line)
                    if match:
                        try:
                            total_size += float(match.group(1)) * (1024 ** 3)
                        except:
                            pass
    except Exception as e:
        print(f"   [WARN] Error reading upload log: {e}")

    return total_size


def can_upload_to_katfile(new_file_size):
    """Check if file can be uploaded to Katfile without exceeding daily limit."""
    uploaded_today = get_katfile_daily_uploaded_size()
    return new_file_size <= (KATFILE_DAILY_LIMIT - uploaded_today)


# ==============================================================================
# KATFILE — Remote stream upload (from Real-Debrid URL)
# ==============================================================================

def upload_to_katfile(download_url, filename, item_idx):
    """Stream file directly from Real-Debrid download URL to Katfile using 3-step API."""
    if not KATFILE_API_KEY:
        print(f"   [{item_idx}] Katfile API key not loaded")
        return None

    try:
        print(f"   [{item_idx}] Uploading to Katfile: {filename}")

        print(f"   [{item_idx}] Step 1/3: Getting upload server...")
        server_response = requests.get(
            KATFILE_UPLOAD_SERVER_ENDPOINT,
            params={'key': KATFILE_API_KEY},
            timeout=10
        )

        if server_response.status_code != 200:
            print(f"   [{item_idx}] Failed to get upload server: {server_response.status_code}")
            return None

        server_data = server_response.json()
        upload_url = server_data.get('result')
        sess_id = server_data.get('sess_id')

        if not upload_url or not sess_id:
            print(f"   [{item_idx}] Invalid upload server response: {server_data}")
            return None

        print(f"   [{item_idx}] Step 2/3: Uploading file to server (streaming from RD)...")
        with requests.get(download_url, stream=True, timeout=600) as rd_response:
            if rd_response.status_code != 200:
                print(f"   [{item_idx}] Failed to access RD download URL: {rd_response.status_code}")
                return None

            files = {'file_0': (filename, rd_response.raw, 'application/octet-stream')}
            data = {'sess_id': sess_id, 'utype': 'prem'}

            upload_response = requests.post(upload_url, files=files, data=data, timeout=600)

            if upload_response.status_code != 200:
                print(f"   [{item_idx}] Upload failed: {upload_response.status_code}")
                return None

            upload_result = upload_response.json()
            if isinstance(upload_result, list) and len(upload_result) > 0:
                file_data = upload_result[0]
                file_code = file_data.get('file_code')
                file_status = file_data.get('file_status')

                if file_status != 'OK' or not file_code:
                    print(f"   [{item_idx}] Upload status: {file_status}")
                    return None
            else:
                print(f"   [{item_idx}] Invalid upload response: {upload_result}")
                return None

        katfile_url = f"{KATFILE_DOMAIN}/{file_code}"
        print(f"   [{item_idx}] Step 3/3: Uploaded -> {katfile_url}")

        return {
            'katfile_url': katfile_url,
            'file_code': file_code,
            'filename': filename
        }

    except requests.exceptions.Timeout:
        print(f"   [{item_idx}] Request timeout")
        return None
    except Exception as e:
        print(f"   [{item_idx}] Katfile upload error: {e}")
        return None


# ==============================================================================
# KATFILE — Local file upload
# ==============================================================================

def upload_local_file_to_katfile(local_file_path, item_idx):
    """Upload a local file from disk to Katfile using the 3-step API."""
    if not KATFILE_API_KEY:
        print(f"   [Katfile Local] API key not loaded")
        return None

    filename = os.path.basename(local_file_path)
    file_size = os.path.getsize(local_file_path)

    try:
        print(f"   [Katfile Local] [{item_idx}] Uploading: {filename} ({file_size / (1024**2):.2f} MB)...")

        server_response = requests.get(
            KATFILE_UPLOAD_SERVER_ENDPOINT,
            params={'key': KATFILE_API_KEY},
            timeout=10
        )

        if server_response.status_code != 200:
            print(f"   [Katfile Local] [{item_idx}] Failed to get server: {server_response.status_code}")
            return None

        server_data = server_response.json()
        upload_url = server_data.get('result')
        sess_id = server_data.get('sess_id')

        if not upload_url or not sess_id:
            print(f"   [Katfile Local] [{item_idx}] Invalid server response")
            return None

        with open(local_file_path, 'rb') as f:
            files = {'file_0': (filename, f, 'application/octet-stream')}
            data = {'sess_id': sess_id, 'utype': 'prem'}
            upload_response = requests.post(upload_url, files=files, data=data, timeout=1200)

        if upload_response.status_code != 200:
            print(f"   [Katfile Local] [{item_idx}] [FAIL] Upload failed: {upload_response.status_code}")
            return None

        upload_result = upload_response.json()
        if isinstance(upload_result, list) and len(upload_result) > 0:
            file_data = upload_result[0]
            file_code = file_data.get('file_code')
            file_status = file_data.get('file_status')

            if file_status != 'OK' or not file_code:
                print(f"   [Katfile Local] [{item_idx}] [FAIL] Upload status: {file_status}")
                return None

            katfile_url = f"{KATFILE_DOMAIN}/{file_code}"
            print(f"   [Katfile Local] [{item_idx}] [OK] Uploaded: {katfile_url}")

            register_mirror_in_link_sharing(filename, katfile_url)
            _log_upload(filename, file_size, "katfile")

            return {
                'katfile_url': katfile_url,
                'file_code': file_code,
                'filename': filename
            }
        return None
    except Exception as e:
        print(f"   [Katfile Local] [{item_idx}] [FAIL] Upload error: {e}")
        return None


# ==============================================================================
# PIXELDRAIN
# ==============================================================================

def upload_local_to_pixeldrain(local_file_path, item_idx):
    """Upload a local file to Pixeldrain."""
    if not PIXELDRAIN_KEY:
        return None
    filename = os.path.basename(local_file_path)
    try:
        print(f"   [Pixeldrain] [{item_idx}] Uploading: {filename}...")
        from requests.auth import HTTPBasicAuth
        auth = HTTPBasicAuth(login="", password=PIXELDRAIN_KEY)
        with open(local_file_path, "rb") as f:
            resp = requests.post(
                "https://pixeldrain.com/api/file",
                files={"file": (filename, f)},
                auth=auth,
                timeout=1200
            )
        if resp.status_code in (200, 201):
            data = resp.json()
            file_id = data.get("id")
            if file_id:
                url = f"https://pixeldrain.com/u/{file_id}"
                print(f"   [Pixeldrain] [{item_idx}] [OK] Uploaded: {url}")
                register_mirror_in_link_sharing(filename, url)
                _log_upload(filename, os.path.getsize(local_file_path), "pixeldrain")
                return {"url": url, "filename": filename}
            else:
                print(f"   [Pixeldrain] [{item_idx}] [FAIL] No id in response: {data}")
        else:
            try:
                err_data = resp.json()
                print(f"   [Pixeldrain] [{item_idx}] [FAIL] Status {resp.status_code}: {err_data}")
            except Exception:
                print(f"   [Pixeldrain] [{item_idx}] [FAIL] Status {resp.status_code}: {resp.text[:200]}")
        return None
    except Exception as e:
        print(f"   [Pixeldrain] [{item_idx}] [FAIL] Upload error: {e}")
        return None


# ==============================================================================
# 1FICHIER
# ==============================================================================

def upload_local_to_1fichier(local_file_path, item_idx):
    """Upload a local file to 1fichier."""
    if not ONEFICHIER_KEY:
        return None
    filename = os.path.basename(local_file_path)
    try:
        print(f"   [1fichier] [{item_idx}] Uploading: {filename}...")
        headers = {
            "Authorization": f"Bearer {ONEFICHIER_KEY}",
            "Content-Type": "application/json",
        }
        srv_resp = requests.post("https://api.1fichier.com/v1/upload/get_upload_server.cgi", headers=headers, timeout=15)
        if srv_resp.status_code != 200:
            print(f"   [1fichier] [{item_idx}] [FAIL] Could not get upload server: {srv_resp.status_code} {srv_resp.text[:200]}")
            return None
        srv_data = srv_resp.json()
        upload_url = srv_data.get("url")
        upload_id = srv_data.get("id")
        if not upload_url:
            print(f"   [1fichier] [{item_idx}] [FAIL] No upload URL in response: {srv_data}")
            return None
        with open(local_file_path, "rb") as f:
            resp = requests.post(
                upload_url,
                files={"file[]": (filename, f)},
                data={"id": upload_id},
                timeout=1200
            )
        if resp.status_code in (200, 201):
            try:
                res = resp.json()
            except Exception:
                res = {}
            url = None
            links = res.get("links", [])
            if links:
                url = links[0].get("download") or links[0].get("link")
            if not url:
                url = res.get("link") or res.get("download_url") or res.get("url")
            if url:
                print(f"   [1fichier] [{item_idx}] [OK] Uploaded: {url}")
                register_mirror_in_link_sharing(filename, url)
                _log_upload(filename, os.path.getsize(local_file_path), "1fichier")
                return {"url": url, "filename": filename}
            else:
                print(f"   [1fichier] [{item_idx}] [FAIL] No download URL in response: {res}")
        else:
            try:
                err_data = resp.json()
                print(f"   [1fichier] [{item_idx}] [FAIL] Status {resp.status_code}: {err_data}")
            except Exception:
                print(f"   [1fichier] [{item_idx}] [FAIL] Status {resp.status_code}: {resp.text[:200]}")
        return None
    except Exception as e:
        print(f"   [1fichier] [{item_idx}] [FAIL] Upload error: {e}")
        return None


# ==============================================================================
# GOFILE
# ==============================================================================

def upload_local_to_gofile(local_file_path, item_idx):
    """Upload a local file to Gofile."""
    if not GOFILE_KEY:
        return None
    filename = os.path.basename(local_file_path)
    try:
        print(f"   [Gofile] [{item_idx}] Uploading: {filename}...")
        srv_resp = requests.get("https://api.gofile.io/servers", timeout=15)
        if srv_resp.status_code != 200:
            print(f"   [Gofile] [{item_idx}] [FAIL] Could not get servers")
            return None
        srv_data = srv_resp.json()
        servers = srv_data.get("data", {}).get("servers", [])
        if not servers:
            print(f"   [Gofile] [{item_idx}] [FAIL] No servers available")
            return None
        server = servers[0].get("name")
        with open(local_file_path, "rb") as f:
            resp = requests.post(
                f"https://{server}.gofile.io/contents/uploadfile",
                files={"file": (filename, f)},
                data={"token": GOFILE_KEY},
                timeout=1200
            )
        if resp.status_code == 200:
            res = resp.json()
            if res.get("status") == "ok":
                url = res.get("data", {}).get("downloadPage")
                if url:
                    print(f"   [Gofile] [{item_idx}] [OK] Uploaded: {url}")
                    register_mirror_in_link_sharing(filename, url)
                    _log_upload(filename, os.path.getsize(local_file_path), "gofile")
                    return {"url": url, "filename": filename}
        print(f"   [Gofile] [{item_idx}] [FAIL] Status {resp.status_code}")
        return None
    except Exception as e:
        print(f"   [Gofile] [{item_idx}] [FAIL] Upload error: {e}")
        return None


# ==============================================================================
# FALLBACK ORCHESTRATOR
# ==============================================================================

def upload_local_with_fallbacks(local_file_path, item_idx):
    """Try Gofile, Pixeldrain, 1fichier, K2S/FileBoom, then Katfile as last resort."""
    file_size = os.path.getsize(local_file_path)
    filename = os.path.basename(local_file_path)

    # 1. Try Gofile
    print(f"[BG Uploader] Trying cloud storage fallbacks for {filename}...")
    result = upload_local_to_gofile(local_file_path, item_idx)
    if result:
        return result

    # 2. Try Pixeldrain
    result = upload_local_to_pixeldrain(local_file_path, item_idx)
    if result:
        return result

    # 3. Try 1fichier
    result = upload_local_to_1fichier(local_file_path, item_idx)
    if result:
        return result

    # 4. Try K2S/FileBoom dual uploader
    try:
        from k2s_uploader import upload_file_dual, is_token_valid
        if is_token_valid():
            res = upload_file_dual(local_file_path)
            if res and res.get("link"):
                _log_upload(filename, file_size, res['service'])
                register_mirror_in_link_sharing(filename, res["link"])
                return {"url": res["link"], "filename": filename}
    except ImportError:
        pass

    # 5. Try Katfile as last resort (if within daily quota)
    if KATFILE_API_KEY and file_size <= KATFILE_DAILY_LIMIT and can_upload_to_katfile(file_size):
        result = upload_local_file_to_katfile(local_file_path, item_idx)
        if result:
            return result

    print(f"[BG Uploader] [FAIL] All upload services failed for {filename}")
    return None
