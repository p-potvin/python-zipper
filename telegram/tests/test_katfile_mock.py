#!/usr/bin/env python3
"""
Test Katfile uploader with mock file stream
This validates the upload pipeline works without needing Real-Debrid
"""

import os
import io
import requests
import datetime

# ==============================================================================
# CONFIGURATION
# ==============================================================================

KATFILE_API_KEY_FILE = r"C:\Users\Administrator\Desktop\Github Repos\.access\katfiles_api.txt"
KATFILE_API_BASE = "https://katfile.com/api/file"

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
    Create an in-memory test file stream to simulate Real-Debrid download
    """
    print(f"\n   [Test] Creating {size_mb}MB mock file stream...")
    
    # Create test content (1MB of test data)
    test_data = b'X' * (size_mb * 1024 * 1024)
    
    # Return BytesIO object that mimics a file stream
    file_stream = io.BytesIO(test_data)
    
    return file_stream, f"test_file_{size_mb}mb.bin"


def upload_to_katfile(file_stream, filename):
    """
    Upload file stream to Katfile API
    """
    print(f"\n   [Katfile] Uploading {filename}...")
    
    try:
        # Prepare multipart form data with file stream
        print(f"   [Katfile] Preparing upload to Katfile API...")
        
        files = {
            'file': (filename, file_stream, 'application/octet-stream')
        }
        
        data = {
            'api_key': KATFILE_API_KEY,
            'file_code': 'null'
        }
        
        print(f"   [Katfile] Sending upload request...")
        upload_response = requests.post(
            KATFILE_API_BASE,
            files=files,
            data=data,
            timeout=600
        )
        
        print(f"   [Katfile] Response status: HTTP {upload_response.status_code}")
        
        if upload_response.status_code == 200:
            result = upload_response.json()
            print(f"   [Katfile] Response: {result}")
            
            if result.get('status') == 'ok':
                katfile_data = result.get('data', {}).get('file', {})
                katfile_url = katfile_data.get('url')
                file_code = katfile_data.get('code')
                
                print(f"   [Katfile] [OK] Upload successful!")
                print(f"   [Katfile] URL: {katfile_url}")
                print(f"   [Katfile] Code: {file_code}")
                
                return {
                    'katfile_url': katfile_url,
                    'file_code': file_code,
                    'filename': filename
                }
            else:
                error_msg = result.get('status_text', 'Unknown error')
                print(f"   [Katfile] [FAIL] Upload failed: {error_msg}")
                return None
        else:
            print(f"   [Katfile] [FAIL] Failed (HTTP {upload_response.status_code})")
            print(f"   [Katfile] Response: {upload_response.text[:500]}")
            return None
            
    except Exception as e:
        print(f"   [Katfile] [FAIL] Exception: {e}")
        return None


def test_katfile_upload():
    """
    Test Katfile upload with mock file stream
    """
    print("\n" + "="*80)
    print("TESTING KATFILE UPLOAD PIPELINE (MOCK STREAM)")
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
        
        # Upload to Katfile
        result = upload_to_katfile(file_stream, filename)
        
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
            f.write(f"\n\n[{datetime.datetime.now()}] Mock Stream Test ({len(results)} uploads)\n")
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
    test_katfile_upload()
