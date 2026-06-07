#!/usr/bin/env python3
"""
Test Katfile uploader with CORRECTED 3-step API process
"""

import os
import io
import requests
import datetime

# ==============================================================================
# CONFIGURATION
# ==============================================================================

KATFILE_API_KEY_FILE = r"C:\Users\Administrator\Desktop\Github Repos\.access\katfiles_api.txt"
KATFILE_UPLOAD_SERVER_ENDPOINT = "https://katfile.space/api/upload/server"
KATFILE_DOMAIN = "https://katfile.space"

# Load Katfile API key
KATFILE_API_KEY = None
try:
    with open(KATFILE_API_KEY_FILE, 'r') as f:
        KATFILE_API_KEY = f.read().strip()
    print(f"[OK] Katfile API key loaded: {KATFILE_API_KEY[:20]}...")
except Exception as e:
    print(f"[FAIL] Failed to load Katfile API key: {e}")
    exit(1)

OUTPUT_DIR = r"telegram/output"
UPLOADS_LOG = os.path.join(OUTPUT_DIR, "uploads_log.txt")

# ==============================================================================
# FUNCTIONS
# ==============================================================================

def create_test_file_stream(size_mb=10):
    """
    Create an in-memory test file stream
    """
    print(f"\n   [Test] Creating {size_mb}MB mock file stream...")
    test_data = b'X' * (size_mb * 1024 * 1024)
    file_stream = io.BytesIO(test_data)
    return file_stream, f"test_file_{size_mb}mb.bin"


def upload_to_katfile_3step(file_stream, filename):
    """
    Upload file to Katfile using CORRECT 3-step API process
    
    Step 1. Select a file server which is ready to accept an upload:
        GET https://katfile.space/api/upload/server?key=your_key
        Response: {"result":"https://s959.katfile.space/cgi-bin/upload.cgi","sess_id":"...","msg":"OK","status":200}
    
    Step 2. Upload to the pre-selected server:
        POST to that server URL with sess_id, utype, file_0
        Response: [{"file_code":"yzanp0ps7sgl","file_status":"OK"}]
    
    Step 3. Construct resulting file link:
        https://katfile.space/{file_code}
    """
    print(f"\n   [Katfile] Uploading {filename} (3-step API)...")
    
    try:
        # ===== STEP 1 =====
        print(f"   [Katfile] Step 1/3: Getting upload server...")
        server_response = requests.get(
            KATFILE_UPLOAD_SERVER_ENDPOINT,
            params={'key': KATFILE_API_KEY},
            timeout=10
        )
        
        if server_response.status_code != 200:
            print(f"   [Katfile] [FAIL] Failed to get upload server: HTTP {server_response.status_code}")
            print(f"   [Katfile] Response: {server_response.text[:300]}")
            return None
        
        try:
            server_data = server_response.json()
            print(f"   [Katfile] Server response: {server_data}")
            
            upload_server_url = server_data.get('result')
            sess_id = server_data.get('sess_id')
            status = server_data.get('status')
            
            if status != 200 or not upload_server_url or not sess_id:
                print(f"   [Katfile] [FAIL] Invalid server response")
                print(f"   [Katfile] Status: {status}, URL: {upload_server_url}, SessID: {sess_id}")
                return None
            
            print(f"   [Katfile] [OK] Got upload server: {upload_server_url}")
            print(f"   [Katfile] [OK] Session ID: {sess_id}")
            
        except Exception as e:
            print(f"   [Katfile] [FAIL] Failed to parse server response: {str(e)}")
            print(f"   [Katfile] Raw response: {server_response.text[:500]}")
            return None
        
        # ===== STEP 2 =====
        print(f"   [Katfile] Step 2/3: Uploading file to server...")
        
        # Reset file stream position to beginning
        file_stream.seek(0)
        
        files = {
            'file_0': (filename, file_stream, 'application/octet-stream')
        }
        
        data = {
            'sess_id': sess_id,
            'utype': 'prem'
        }
        
        print(f"   [Katfile] Sending to: {upload_server_url}")
        upload_response = requests.post(
            upload_server_url,
            files=files,
            data=data,
            timeout=300
        )
        
        print(f"   [Katfile] Upload response status: HTTP {upload_response.status_code}")
        
        if upload_response.status_code != 200:
            print(f"   [Katfile] [FAIL] Upload failed: HTTP {upload_response.status_code}")
            print(f"   [Katfile] Response: {upload_response.text[:500]}")
            return None
        
        try:
            upload_result = upload_response.json()
            print(f"   [Katfile] Upload response: {upload_result}")
            
            # Response should be like: [{"file_code":"yzanp0ps7sgl","file_status":"OK"}]
            if not isinstance(upload_result, list) or len(upload_result) == 0:
                print(f"   [Katfile] [FAIL] Invalid upload response format")
                return None
            
            file_data = upload_result[0]
            file_code = file_data.get('file_code')
            file_status = file_data.get('file_status')
            
            if file_status != 'OK':
                print(f"   [Katfile] [FAIL] Upload status: {file_status}")
                return None
            
            if not file_code:
                print(f"   [Katfile] [FAIL] No file_code in response")
                return None
            
            print(f"   [Katfile] [OK] Upload successful")
            print(f"   [Katfile] [OK] File code: {file_code}")
            
        except Exception as e:
            print(f"   [Katfile] [FAIL] Failed to parse upload response: {str(e)}")
            print(f"   [Katfile] Raw response: {upload_response.text[:500]}")
            return None
        
        # ===== STEP 3 =====
        print(f"   [Katfile] Step 3/3: Constructing final URL...")
        katfile_url = f"{KATFILE_DOMAIN}/{file_code}"
        
        print(f"   [Katfile] [OK] File uploaded successfully!")
        print(f"   [Katfile] URL: {katfile_url}")
        
        return {
            'katfile_url': katfile_url,
            'file_code': file_code,
            'filename': filename
        }
    
    except requests.exceptions.Timeout:
        print(f"   [Katfile] [FAIL] Request timeout")
        return None
    except Exception as e:
        print(f"   [Katfile] [FAIL] Upload error: {str(e)}")
        import traceback
        traceback.print_exc()
        return None


def test_katfile_3step_api():
    """
    Test Katfile 3-step API with mock file streams
    """
    print("\n" + "="*80)
    print("TESTING KATFILE 3-STEP API (CORRECTED)")
    print("="*80)
    
    if not KATFILE_API_KEY:
        print("[FAIL] Katfile API key not loaded")
        return
    
    print(f"[OK] Katfile API key loaded")
    
    # Test with different file sizes
    test_sizes = [1, 5]  # MB
    results = []
    
    for size_mb in test_sizes:
        print(f"\n[Test {test_sizes.index(size_mb) + 1}/{len(test_sizes)}] Testing {size_mb}MB upload")
        print("-" * 80)
        
        # Create mock file stream
        file_stream, filename = create_test_file_stream(size_mb)
        
        # Upload to Katfile using corrected 3-step API
        result = upload_to_katfile_3step(file_stream, filename)
        
        if result:
            results.append(result)
            print(f"[OK] Success")
        else:
            print(f"[FAIL] Failed")
    
    # Write results to log
    if results:
        print(f"\n" + "="*80)
        print(f"UPLOAD RESULTS ({len(results)} successful)")
        print("="*80)
        
        with open(UPLOADS_LOG, 'a', encoding='utf-8') as f:
            f.write(f"\n\n[{datetime.datetime.now()}] 3-Step API Test ({len(results)} uploads)\n")
            f.write("=" * 80 + "\n\n")
            for i, result in enumerate(results, 1):
                f.write(f"[{i}] {result['filename']}\n")
                f.write(f"    Katfile URL: {result['katfile_url']}\n")
                f.write(f"    File Code: {result['file_code']}\n\n")
        
        print(f"\n[OK] Logged {len(results)} uploads to {UPLOADS_LOG}")
        
        # Display results
        for i, result in enumerate(results, 1):
            print(f"\n[{i}] {result['filename']}")
            print(f"    Katfile URL: {result['katfile_url']}")
            print(f"    File Code: {result['file_code']}")
    else:
        print(f"\n[FAIL] No successful uploads")


if __name__ == '__main__':
    test_katfile_3step_api()
