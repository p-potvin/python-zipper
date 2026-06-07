#!/usr/bin/env python3
"""
Test Katfile uploader with existing MEGA links from resolved_links.txt
This tests the Real-Debrid → Katfile streaming pipeline WITHOUT requiring Telegram access
"""

import os
import asyncio
import requests
import datetime
from urllib.parse import quote

# ==============================================================================
# CONFIGURATION
# ==============================================================================

# API Credentials
REALDEBRID_API_KEY_FILE = r"C:\Users\Administrator\Desktop\Github Repos\.access\realdebrid_api.txt"
KATFILE_API_KEY_FILE = r"C:\Users\Administrator\Desktop\Github Repos\.access\katfiles_api.txt"

REALDEBRID_API_BASE = "https://api.real-debrid.com/rest/1.0"
KATFILE_API_BASE = "https://katfile.com/api/file"

# Load credentials
REALDEBRID_API_TOKEN = None
KATFILE_API_KEY = None

try:
    with open(REALDEBRID_API_KEY_FILE, 'r') as f:
        REALDEBRID_API_TOKEN = f.read().strip()
    print(f"[OK] Real-Debrid token loaded: {REALDEBRID_API_TOKEN[:20]}...")
except Exception as e:
    print(f"[FAIL] Failed to load Real-Debrid token: {e}")

try:
    with open(KATFILE_API_KEY_FILE, 'r') as f:
        KATFILE_API_KEY = f.read().strip()
    print(f"[OK] Katfile API key loaded: {KATFILE_API_KEY[:20]}...")
except Exception as e:
    print(f"[FAIL] Failed to load Katfile API key: {e}")

OUTPUT_DIR = r"telegram/output"
UPLOADS_LOG = os.path.join(OUTPUT_DIR, "uploads_log.txt")
RESOLVED_LINKS_FILE = os.path.join(OUTPUT_DIR, "resolved_links.txt")

# ==============================================================================
# FUNCTIONS
# ==============================================================================

def unrestrict_mega_with_realdebrid(mega_url):
    """
    Use Real-Debrid API to unrestrict a MEGA link and get direct download URL
    """
    print(f"\n   [Real-Debrid] Unrestricting {mega_url}...")
    
    headers = {
        'Authorization': f'Bearer {REALDEBRID_API_TOKEN}',
        'Content-Type': 'application/x-www-form-urlencoded'
    }
    
    payload = {
        'link': mega_url
    }
    
    try:
        response = requests.post(
            f"{REALDEBRID_API_BASE}/unrestrict/link",
            headers=headers,
            data=payload,
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            filename = data.get('filename', 'unknown_file')
            filesize = data.get('filesize', 0)
            download_url = data.get('download', '')
            
            print(f"   [Real-Debrid] [OK] Unrestricted: {filename} ({filesize / (1024**3):.2f} GB)")
            print(f"   [Real-Debrid] Download URL: {download_url[:80]}...")
            
            return {
                'filename': filename,
                'filesize': filesize,
                'download_url': download_url
            }
        else:
            print(f"   [Real-Debrid] [FAIL] Failed (HTTP {response.status_code}): {response.text[:200]}")
            return None
            
    except Exception as e:
        print(f"   [Real-Debrid] [FAIL] Exception: {e}")
        return None


def upload_to_katfile(download_url, filename):
    """
    Stream file directly from Real-Debrid download URL to Katfile (no local storage)
    """
    print(f"\n   [Katfile] Uploading {filename}...")
    
    try:
        # Open streaming connection to Real-Debrid download URL
        print(f"   [Katfile] Opening stream from Real-Debrid...")
        stream_response = requests.get(download_url, stream=True, timeout=600)
        
        if stream_response.status_code != 200:
            print(f"   [Katfile] [FAIL] Failed to stream from Real-Debrid (HTTP {stream_response.status_code})")
            return None
        
        # Prepare multipart form data with streamed file
        print(f"   [Katfile] Preparing upload to Katfile...")
        
        files = {
            'file': (filename, stream_response.raw, 'application/octet-stream')
        }
        
        data = {
            'api_key': KATFILE_API_KEY,
            'file_code': 'null'  # Let Katfile generate new code
        }
        
        # Upload to Katfile
        print(f"   [Katfile] Starting upload...")
        upload_response = requests.post(
            KATFILE_API_BASE,
            files=files,
            data=data,
            timeout=600
        )
        
        if upload_response.status_code == 200:
            result = upload_response.json()
            
            if result.get('status') == 'ok':
                katfile_url = result.get('data', {}).get('file', {}).get('url')
                file_code = result.get('data', {}).get('file', {}).get('code')
                
                print(f"   [Katfile] [OK] Uploaded successfully!")
                print(f"   [Katfile] URL: {katfile_url}")
                print(f"   [Katfile] Code: {file_code}")
                
                return {
                    'katfile_url': katfile_url,
                    'file_code': file_code,
                    'filename': filename
                }
            else:
                print(f"   [Katfile] [FAIL] Upload failed: {result.get('status_text', 'Unknown error')}")
                return None
        else:
            print(f"   [Katfile] [FAIL] Failed (HTTP {upload_response.status_code}): {upload_response.text[:200]}")
            return None
            
    except Exception as e:
        print(f"   [Katfile] [FAIL] Exception: {e}")
        return None


def test_katfile_pipeline():
    """
    Test pipeline: MEGA → Real-Debrid → Katfile
    """
    print("\n" + "="*80)
    print("TESTING KATFILE UPLOAD PIPELINE")
    print("="*80)
    
    # Check credentials
    if not REALDEBRID_API_TOKEN:
        print("[FAIL] Real-Debrid API token not found")
        return
    
    if not KATFILE_API_KEY:
        print("[FAIL] Katfile API key not found")
        return
    
    print(f"[OK] Credentials loaded")
    
    # Load MEGA links from resolved_links.txt
    if not os.path.exists(RESOLVED_LINKS_FILE):
        print(f"[FAIL] File not found: {RESOLVED_LINKS_FILE}")
        return
    
    mega_links = []
    with open(RESOLVED_LINKS_FILE, 'r') as f:
        mega_links = [line.strip() for line in f if line.strip()]
    
    if not mega_links:
        print(f"[FAIL] No MEGA links found in {RESOLVED_LINKS_FILE}")
        return
    
    print(f"[OK] Found {len(mega_links)} MEGA links to test")
    
    # Test each link
    results = []
    for idx, mega_link in enumerate(mega_links, 1):
        print(f"\n[{idx}/{len(mega_links)}] Testing: {mega_link}")
        print("-" * 80)
        
        # Step 1: Unrestrict with Real-Debrid
        unrestricted = unrestrict_mega_with_realdebrid(mega_link)
        
        if not unrestricted:
            print(f"[{idx}] [FAIL] Skipped (Real-Debrid unrestriction failed)")
            continue
        
        # Step 2: Upload to Katfile
        katfile_result = upload_to_katfile(
            unrestricted['download_url'],
            unrestricted['filename']
        )
        
        if not katfile_result:
            print(f"[{idx}] [FAIL] Skipped (Katfile upload failed)")
            continue
        
        # Store successful result
        results.append({
            'mega_url': mega_link,
            'filename': unrestricted['filename'],
            'filesize': unrestricted['filesize'],
            'katfile_url': katfile_result['katfile_url'],
            'file_code': katfile_result['file_code']
        })
        
        print(f"[{idx}] [OK] SUCCESS")
    
    # Write results to log
    if results:
        print(f"\n" + "="*80)
        print(f"UPLOAD LOG ({len(results)} successful uploads)")
        print("="*80)
        
        with open(UPLOADS_LOG, 'a', encoding='utf-8') as f:
            f.write(f"\n\n[{datetime.datetime.now()}] Test Batch ({len(results)} files)\n")
            f.write("=" * 80 + "\n\n")
            for i, result in enumerate(results, 1):
                f.write(f"[{i}] {result['filename']}\n")
                f.write(f"    MEGA: {result['mega_url']}\n")
                f.write(f"    Size: {result['filesize'] / (1024**3):.2f} GB\n")
                f.write(f"    Katfile: {result['katfile_url']}\n")
                f.write(f"    Code: {result['file_code']}\n\n")
        
        print(f"\n[OK] Logged {len(results)} uploads to {UPLOADS_LOG}")
        
        # Display results
        for i, result in enumerate(results, 1):
            print(f"\n[{i}] {result['filename']}")
            print(f"    Size: {result['filesize'] / (1024**3):.2f} GB")
            print(f"    Katfile URL: {result['katfile_url']}")
            print(f"    File Code: {result['file_code']}")
    else:
        print(f"\n[FAIL] No successful uploads")


if __name__ == '__main__':
    test_katfile_pipeline()
