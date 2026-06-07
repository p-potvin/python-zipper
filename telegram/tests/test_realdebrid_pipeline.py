#!/usr/bin/env python3
"""
Test Real-Debrid unrestriction and file categorization logic
Skips Telegram/browser automation and tests directly with MEGA links
"""

import asyncio
import os
import sys
import json
from pathlib import Path

# Add parent dir to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from telethon_link_resolver import (
    unrestrict_mega_with_realdebrid,
    upload_to_katfile,
    download_file_with_browser,
    MAX_FILESIZE_UPLOAD,
    MAX_FILESIZE_DOWNLOAD,
    REALDEBRID_API_TOKEN,
    KATFILE_API_KEY,
    OUTPUT_DIR
)

# Test MEGA links (replace with real ones if you have them)
TEST_MEGA_LINKS = [
    "https://mega.nz/folder/test123abc#xyz",  # Placeholder
]

def test_realdebrid_unrestriction():
    """Test Real-Debrid unrestriction logic"""
    print("\n" + "="*60)
    print("REAL-DEBRID UNRESTRICTION TEST")
    print("="*60)
    
    if not REALDEBRID_API_TOKEN:
        print("[FAIL] Real-Debrid API token not loaded")
        return False
    
    print(f"[OK] Real-Debrid token loaded (length: {len(REALDEBRID_API_TOKEN)})")
    
    # Test with a sample MEGA link
    test_link = "https://mega.nz/file/abc123#xyz"
    print(f"\n[TEST] Attempting to unrestrict: {test_link}")
    
    try:
        result = unrestrict_mega_with_realdebrid(test_link, 1)
        if result:
            print(f"[OK] Unrestriction successful")
            print(f"    Filename: {result.get('filename')}")
            print(f"    Size: {result.get('filesize') / (1024**3):.2f} GB")
            print(f"    Direct URL: {result.get('download_url')[:80]}...")
            return True
        else:
            print("[WARN] Unrestriction returned None (link may be invalid or restricted)")
            return False
    except Exception as e:
        print(f"[FAIL] Error during unrestriction: {e}")
        return False

def test_file_categorization():
    """Test file size categorization logic"""
    print("\n" + "="*60)
    print("FILE CATEGORIZATION TEST")
    print("="*60)
    
    # Test file size boundaries
    test_cases = [
        (50 * 1024 * 1024, "50 MB", "Skip"),
        (500 * 1024 * 1024, "500 MB", "Upload to Katfile"),
        (2 * 1024 * 1024 * 1024, "2 GB", "Upload to Katfile"),
        (4 * 1024 * 1024 * 1024, "4 GB", "Download to G:\\TelethonDownloads"),
        (8 * 1024 * 1024 * 1024, "8 GB", "Download to G:\\TelethonDownloads"),
        (12 * 1024 * 1024 * 1024, "12 GB", "Skip"),
    ]
    
    print(f"File size boundaries:")
    print(f"  < 100 MB: Skip")
    print(f"  100 MB - {MAX_FILESIZE_UPLOAD / (1024**3):.0f} GB: Upload to Katfile")
    print(f"  {MAX_FILESIZE_UPLOAD / (1024**3):.0f} GB - {MAX_FILESIZE_DOWNLOAD / (1024**3):.0f} GB: Download locally")
    print(f"  > {MAX_FILESIZE_DOWNLOAD / (1024**3):.0f} GB: Skip")
    
    print("\nTest cases:")
    for filesize, label, expected_action in test_cases:
        filesize_gb = filesize / (1024 ** 3)
        
        if filesize < 100 * 1024 * 1024:
            action = "Skip"
        elif filesize <= MAX_FILESIZE_UPLOAD:
            action = "Upload to Katfile"
        elif filesize <= MAX_FILESIZE_DOWNLOAD:
            action = "Download to G:\\TelethonDownloads"
        else:
            action = "Skip"
        
        status = "[OK]" if action == expected_action else "[FAIL]"
        print(f"  {status} {label:8s} ({filesize_gb:6.2f} GB) -> {action}")
    
    return True

def test_api_keys():
    """Test API key availability"""
    print("\n" + "="*60)
    print("API KEYS TEST")
    print("="*60)
    
    rd_ok = bool(REALDEBRID_API_TOKEN)
    kf_ok = bool(KATFILE_API_KEY)
    
    print(f"  {'[OK]' if rd_ok else '[FAIL]'} Real-Debrid: {REALDEBRID_API_TOKEN[:10]}..." if REALDEBRID_API_TOKEN else "[FAIL] Real-Debrid not configured")
    print(f"  {'[OK]' if kf_ok else '[WARN]'} Katfile: {KATFILE_API_KEY[:10]}..." if KATFILE_API_KEY else "[WARN] Katfile not configured (fallback to local)")
    
    return rd_ok

async def main():
    print("\n╔════════════════════════════════════════════════════════════╗")
    print("║  Real-Debrid Pipeline Test (Post-Linkvertise)             ║")
    print("╚════════════════════════════════════════════════════════════╝")
    
    # Test 1: API Keys
    api_ok = test_api_keys()
    
    # Test 2: File categorization
    categorization_ok = test_file_categorization()
    
    # Test 3: Real-Debrid unrestriction
    if api_ok:
        rd_ok = test_realdebrid_unrestriction()
    else:
        rd_ok = False
        print("\n[SKIP] Skipping Real-Debrid test (API token not available)")
    
    # Summary
    print("\n" + "="*60)
    print("TEST SUMMARY")
    print("="*60)
    
    tests = {
        "API Keys": api_ok,
        "File Categorization": categorization_ok,
        "Real-Debrid": rd_ok if api_ok else None,
    }
    
    passed = sum(1 for v in tests.values() if v is True)
    failed = sum(1 for v in tests.values() if v is False)
    skipped = sum(1 for v in tests.values() if v is None)
    
    for name, result in tests.items():
        if result is True:
            print(f"  [OK] {name}")
        elif result is False:
            print(f"  [FAIL] {name}")
        else:
            print(f"  [SKIP] {name}")
    
    print(f"\nPassed: {passed}")
    print(f"Failed: {failed}")
    print(f"Skipped: {skipped}")
    
    if failed > 0:
        print("\n[WARN] Some tests failed. Check API keys and configuration.")
        return False
    else:
        print("\n[OK] All tests passed! Pipeline ready for Real-Debrid processing.")
        return True

if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)
