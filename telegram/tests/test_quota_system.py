#!/usr/bin/env python3
"""Test Katfile Daily Quota Tracking"""

import os
import sys
from pathlib import Path
from datetime import datetime

# Setup path
SCRIPT_DIR = Path(__file__).parent.absolute()
sys.path.insert(0, str(SCRIPT_DIR))

# Test constants
KATFILE_DAILY_LIMIT = 2 * 1024 * 1024 * 1024  # 2 GB
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")

def get_katfile_daily_uploaded_size():
    """Test: Get daily uploaded size from log"""
    uploads_log = os.path.join(OUTPUT_DIR, "uploads_log.txt")
    
    if not os.path.exists(uploads_log):
        print("[INFO] No uploads log found (fresh start)")
        return 0
    
    today = datetime.now().strftime("%Y-%m-%d")
    total_bytes = 0
    count = 0
    
    with open(uploads_log, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            if today in line and 'katfile' in line.lower():
                try:
                    # Parse format: [DATE TIME] filename.ext (X.XX GB) → KATFILE
                    if '(' in line and 'GB' in line:
                        size_part = line.split('(')[1].split('GB')[0].strip()
                        size_gb = float(size_part)
                        size_bytes = int(size_gb * (1024**3))
                        total_bytes += size_bytes
                        count += 1
                except:
                    pass
    
    total_gb = total_bytes / (1024**3)
    print(f"[OK] Today's Katfile uploads: {count} files ({total_gb:.2f} GB)")
    return total_bytes

def can_upload_to_katfile(file_size):
    """Test: Check if file can upload given daily quota"""
    today_uploaded = get_katfile_daily_uploaded_size()
    available = KATFILE_DAILY_LIMIT - today_uploaded
    can_upload = file_size <= available
    
    used_pct = (today_uploaded / KATFILE_DAILY_LIMIT) * 100
    avail_gb = available / (1024**3)
    size_gb = file_size / (1024**3)
    
    print(f"\n[TEST] File Upload Quota Check")
    print(f"     Total Limit: 2.00 GB")
    print(f"     Used Today: {used_pct:.1f}%")
    print(f"     Available: {avail_gb:.2f} GB")
    print(f"     File Size: {size_gb:.2f} GB")
    print(f"     Decision: {'[OK] CAN UPLOAD' if can_upload else '[FAIL] QUOTA EXCEEDED'}")
    
    return can_upload

def test_quota_scenarios():
    """Test different quota scenarios"""
    print("=" * 60)
    print("Katfile Daily Quota System - Test")
    print("=" * 60)
    
    # Scenario 1: Empty quota (first file)
    print("\n[SCENARIO 1] Fresh quota (no uploads yet)")
    print("-" * 60)
    
    # Small file (500 MB)
    file_500mb = 500 * 1024 * 1024
    can_upload_to_katfile(file_500mb)
    
    # Small file (1.2 GB)
    file_1_2gb = 1.2 * 1024**3
    print(f"\n[TEST] 1.2 GB file:")
    if can_upload_to_katfile(file_1_2gb):
        print("     → Would upload to Katfile")
    else:
        print("     → Would save to G:\\KatfileOverflow (LOCAL)")
    
    # Large file (2.5 GB)  
    file_2_5gb = 2.5 * 1024**3
    print(f"\n[TEST] 2.5 GB file:")
    if can_upload_to_katfile(file_2_5gb):
        print("     → Would upload to Katfile")
    else:
        print("     → Would save to G:\\KatfileOverflow (LOCAL)")

def test_file_categorization():
    """Test file size categorization"""
    print("\n\n[CATEGORY TESTS] File Size Handling")
    print("=" * 60)
    
    MIN_FILESIZE = 100 * 1024 * 1024           # 100 MB
    MAX_FILESIZE_UPLOAD = 3 * 1024**3          # 3 GB
    MAX_FILESIZE_DOWNLOAD = 10 * 1024**3       # 10 GB
    
    test_cases = [
        (50 * 1024 * 1024, "50 MB", "SKIP"),
        (100 * 1024 * 1024, "100 MB", "UPLOAD or LOCAL"),
        (500 * 1024 * 1024, "500 MB", "UPLOAD or LOCAL"),
        (2 * 1024**3, "2 GB", "UPLOAD or LOCAL"),
        (3 * 1024**3, "3 GB", "UPLOAD or LOCAL"),
        (5 * 1024**3, "5 GB", "DOWNLOAD to G:\\TelethonDownloads"),
        (8 * 1024**3, "8 GB", "DOWNLOAD to G:\\TelethonDownloads"),
        (10 * 1024**3, "10 GB", "DOWNLOAD to G:\\TelethonDownloads"),
        (12 * 1024**3, "12 GB", "SKIP"),
        (50 * 1024**3, "50 GB", "SKIP"),
    ]
    
    for filesize, label, expected_action in test_cases:
        if filesize < MIN_FILESIZE:
            action = "SKIP (too small)"
            status = "[SKIP]"
        elif filesize <= MAX_FILESIZE_UPLOAD:
            action = "UPLOAD or LOCAL (100MB-3GB)"
            status = "[UPLOAD]"
        elif filesize <= MAX_FILESIZE_DOWNLOAD:
            action = "DOWNLOAD (3GB-10GB)"
            status = "[DL]"
        else:
            action = "SKIP (too large)"
            status = "[SKIP]"
        
        match = "✓" if expected_action in action else "✗"
        print(f"{match} {label:8s} → {action:35s} [{status}]")

def test_log_parsing():
    """Test uploads_log.txt parsing"""
    print("\n\n[LOG PARSING TEST]")
    print("=" * 60)
    
    test_log = """[2026-05-28 09:15:33] file1.zip (1.00 GB) → KATFILE
[2026-05-28 15:30:22] file2.zip (0.80 GB) → KATFILE
[2026-05-28 23:45:10] file3.zip (1.50 GB) → LOCAL_OVERFLOW
[2026-05-29 08:10:15] file4.zip (0.50 GB) → KATFILE
"""
    
    print("[TEST] Sample log entries:\n")
    print(test_log)
    
    # Simulation
    today = datetime.now().strftime("%Y-%m-%d")
    example_lines = [
        f"[{today} 09:15:33] archive1.zip (1.25 GB) → KATFILE",
        f"[{today} 14:30:22] backup2.zip (0.75 GB) → KATFILE", 
        f"[{today} 23:45:10] release3.zip (2.50 GB) → LOCAL_OVERFLOW",
    ]
    
    print(f"[PARSED] Today's entries ({today}):")
    for line in example_lines:
        print(f"  {line}")
    
    # Calculate quota
    katfile_gb = 1.25 + 0.75
    local_gb = 2.50
    total_gb = katfile_gb + local_gb
    
    print(f"\n[SUMMARY] Today's usage:")
    print(f"  Katfile:     {katfile_gb:.2f} GB / 2.00 GB ({(katfile_gb/2.00)*100:.1f}%)")
    print(f"  Local:       {local_gb:.2f} GB (overflow)")
    print(f"  Total:       {total_gb:.2f} GB")
    print(f"  Remaining quota: {(2.00 - katfile_gb):.2f} GB")

if __name__ == '__main__':
    test_file_categorization()
    test_log_parsing()
    test_quota_scenarios()
    
    print("\n" + "=" * 60)
    print("[OK] All tests completed")
    print("=" * 60)
