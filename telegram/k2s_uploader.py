import os
import re
import hashlib
import requests
import time
from urllib.parse import urlparse

# Default token fallback if extraction fails
DEFAULT_TOKEN = '2934193fb5650ad3ceb0f4d8d2d99875267321f2'

# Service Base URLs
FBOOM_BASE = "https://fboom.me/api/v2/"
K2S_BASE = "https://keep2share.cc/api/v2/"

def get_active_token():
    """
    Dynamically extracts the MoneyPlatform access token from the desktop uploader's
    local storage leveldb database files. Fallbacks to the known working token.
    """
    appdata = os.environ.get('APPDATA')
    if not appdata:
        return DEFAULT_TOKEN
        
    db_path = os.path.join(appdata, "Moneyplatform File Uploader", "Local Storage", "leveldb")
    if not os.path.exists(db_path):
        return DEFAULT_TOKEN
        
    token_pattern = re.compile(r'\b[a-f0-9]{40}\b')
    
    # Try reading the log/ldb files, ignore locks or read errors gracefully
    for filename in os.listdir(db_path):
        if filename.endswith('.log') or filename.endswith('.ldb'):
            filepath = os.path.join(db_path, filename)
            try:
                # Read binary file to avoid encoding decode crashes
                with open(filepath, 'rb') as f:
                    content = f.read()
                matches = token_pattern.findall(content.decode('utf-8', errors='ignore'))
                if matches:
                    # Return the first found valid 40-character hex token
                    return matches[0]
            except Exception:
                pass
                
    return DEFAULT_TOKEN

def compute_md5(file_path):
    """Computes the MD5 checksum of a file in chunks."""
    hash_md5 = hashlib.md5()
    try:
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()
    except Exception as e:
        print(f"   [Hasher] Error hashing {os.path.basename(file_path)}: {e}")
        return None

def api_post(endpoint, payload, base_url):
    """Helper to perform JSON POST requests to Keep2Share/FileBoom API endpoints."""
    url = base_url.rstrip('/') + '/' + endpoint.lstrip('/')
    try:
        # The API expects application/json POST requests
        r = requests.post(url, json=payload, timeout=15)
        if r.status_code == 200:
            return r.json()
        elif r.status_code in (400, 403, 406):
            # Known error codes returned as JSON
            try:
                return r.json()
            except ValueError:
                return {"status": "error", "code": r.status_code, "message": r.text}
        else:
            return {"status": "error", "code": r.status_code, "message": f"HTTP error {r.status_code}"}
    except Exception as e:
        return {"status": "error", "code": 500, "message": str(e)}

def upload_file_to_service(file_path, token, base_url):
    """
    Performs the upload sequence for a single service (FileBoom or Keep2Share):
    1. MD5 Hash calculation
    2. createFileByHash (Instant copy shortcut)
    3. Fallback: getUploadFormData -> Multipart Upload POST -> Final Status Link
    """
    filename = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    
    # 1. Compute MD5
    md5_hash = compute_md5(file_path)
    if not md5_hash:
        return None
        
    # 2. Try Instant Copy via Hash
    print(f"   [Upload] [{filename}] Checking server hash cache...")
    hash_payload = {
        "access_token": token,
        "hash": md5_hash,
        "name": filename
    }
    
    hash_res = api_post("createFileByHash", hash_payload, base_url)
    if hash_res and hash_res.get("status") == "success" and "link" in hash_res:
        print(f"   [Upload] [{filename}] [OK] Instant hash match upload!")
        return {
            "link": hash_res["link"],
            "id": hash_res.get("id"),
            "instant": True
        }
    
    # 3. If hash match is not found, perform standard upload
    print(f"   [Upload] [{filename}] Not found in server cache. Performing full multipart upload...")
    form_payload = {
        "access_token": token
    }
    form_res = api_post("getUploadFormData", form_payload, base_url)
    if not form_res or form_res.get("status") != "success":
        msg = form_res.get("message") if form_res else "No response"
        print(f"   [Upload] [{filename}] [FAIL] Failed to retrieve upload form data: {msg}")
        return None
        
    # Extract upload instructions
    form_action = form_res.get("form_action")
    file_field = form_res.get("file_field", "file")
    form_data = form_res.get("form_data", {})
    
    if not form_action:
        print(f"   [Upload] [{filename}] [FAIL] Missing form_action URL")
        return None
        
    # Build multipart fields
    fields = {}
    for k, v in form_data.items():
        fields[k] = str(v)
        
    # Standard multipart file upload
    try:
        print(f"   [Upload] [{filename}] Uploading bytes ({file_size / (1024**2):.2f} MB)...")
        with open(file_path, 'rb') as f:
            files_dict = {file_field: (filename, f)}
            # Perform POST multipart upload
            up_r = requests.post(form_action, data=fields, files=files_dict, timeout=120)
            
        if up_r.status_code == 200:
            try:
                res_data = up_r.json()
            except ValueError:
                # If the uploader response is not json, try to extract link via plain text or regex
                links = re.findall(r'https?://[^\s\'\"`]+', up_r.text)
                if links:
                    return {"link": links[0], "instant": False}
                print(f"   [Upload] [{filename}] [FAIL] Invalid non-JSON response from upload server: {up_r.text[:200]}")
                return None
                
            if res_data.get("status") == "success" or "link" in res_data:
                link = res_data.get("link")
                if not link and "user_file_id" in res_data:
                    # Form URL based on project base domain
                    domain = "fboom.me" if "fboom" in base_url else "k2s.cc"
                    link = f"https://{domain}/file/{res_data['user_file_id']}"
                return {
                    "link": link,
                    "id": res_data.get("user_file_id"),
                    "instant": False
                }
            else:
                print(f"   [Upload] [{filename}] [FAIL] Server rejected file: {res_data}")
                return None
        else:
            print(f"   [Upload] [{filename}] [FAIL] Upload server returned status code {up_r.status_code}")
            return None
    except Exception as e:
        print(f"   [Upload] [{filename}] [FAIL] Network error during upload: {e}")
        return None

def upload_file_dual(file_path):
    """
    Main uploader entry point with service fallback:
    First tries FileBoom (fboom.me), falls back to Keep2Share (k2s.cc).
    """
    token = get_active_token()
    filename = os.path.basename(file_path)
    
    # 1. Try FileBoom
    print(f"   [Dual Uploader] [{filename}] Trying FileBoom (fboom)...")
    res = upload_file_to_service(file_path, token, FBOOM_BASE)
    if res and res.get("link"):
        return {
            "link": res["link"],
            "service": "FBOOM",
            "instant": res.get("instant", False)
        }
        
    # 2. Fallback to Keep2Share
    print(f"   [Dual Uploader] [{filename}] FileBoom failed or skipped. Falling back to Keep2Share (k2s)...")
    res = upload_file_to_service(file_path, token, K2S_BASE)
    if res and res.get("link"):
        return {
            "link": res["link"],
            "service": "K2S",
            "instant": res.get("instant", False)
        }
        
    print(f"   [Dual Uploader] [{filename}] [FAIL] Both FileBoom and Keep2Share uploads failed.")
    return None
