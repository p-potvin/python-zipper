#!/usr/bin/env python3
"""
Telethon Pipeline Setup Validator
Checks all components are installed and configured correctly
"""

import os
import sys
import json
from pathlib import Path

def check(name, condition, remediation=""):
    """Print check result"""
    if condition:
        print(f"  [OK] {name}")
        return True
    elif remediation:
        print(f"  [WARN] {name}: {remediation}")
        return None
    else:
        print(f"  [FAIL] {name}")
        return False

print("\n[TELETHON PIPELINE VALIDATOR]\n")
print("-" * 40)

# Python packages
print("PYTHON DEPENDENCIES")
print("-" * 40)

packages_ok = True
for pkg in ["telethon", "playwright", "requests", "aiohttp", "win10toast"]:
    try:
        __import__(pkg)
        check(pkg, True)
    except ImportError:
        check(pkg, False, f"pip install {pkg}")
        packages_ok = False

# Files
print("\nSCRIPT FILES")
print("-" * 40)

script_dir = r"c:\Users\Administrator\Desktop\Github Repos\python-scripts\telegram"
files_ok = True

for f in ["telethon_link_resolver.py", "setup_scheduled_task.ps1"]:
    path = os.path.join(script_dir, f)
    result = check(f, os.path.exists(path))
    if result is False:
        files_ok = False

# API Keys
print("\nAPI KEYS")
print("-" * 40)

api_dir = r"c:\Users\Administrator\Desktop\Github Repos\.access"
api_ok = True

for key_file in ["realdebrid_api.txt", "katfiles_api.txt"]:
    path = os.path.join(api_dir, key_file)
    result = check(key_file, os.path.exists(path))
    if result is False:
        api_ok = False

# Directories
print("\nDIRECTORIES")
print("-" * 40)

output_dir = os.path.join(script_dir, "output")
check("Output directory", os.path.isdir(output_dir))

g_drive = r"G:\TelethonDownloads"
if not os.path.exists(g_drive):
    print(f"  [!] Large file directory: Will be auto-created on first run")
else:
    check("Large file directory", True)

# Configuration check
print("\nCONFIGURATION")
print("-" * 40)

config_ok = True
tlr_path = os.path.join(script_dir, "telethon_link_resolver.py")

try:
    with open(tlr_path, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()
        has_notif = "send_notification" in content
        has_large = "MAX_FILESIZE_UPLOAD" in content and "MAX_FILESIZE_DOWNLOAD" in content
        
        check("Windows notifications support", has_notif)
        check("Large file handling (3GB-10GB)", has_large)
except Exception as e:
    config_ok = False
    print(f"  [✗] Could not read telethon_link_resolver.py: {e}")

# State file
print("\nPIPELINE STATE")
print("-" * 40)

state_path = os.path.join(output_dir, "pipeline_state.json")
if os.path.exists(state_path):
    try:
        with open(state_path, 'r') as f:
            state = json.load(f)
        check("State file valid JSON", True)
        print(f"    Last message IDs: {state.get('last_first_message_id')} to {state.get('last_last_message_id')}")
    except Exception as e:
        check("State file valid JSON", False, f"Delete and recreate on next run ({e})")
else:
    print("  [i] State file will be created on first run")

# Summary
print("\n" + "=" * 40)
print("SUMMARY")
print("=" * 40)

# Check if any CRITICAL errors (not counting win10toast)
critical_fail = files_ok is False or api_ok is False or config_ok is False

if critical_fail:
    print("\n[WARNING] CRITICAL ERRORS - See above\n")
    sys.exit(1)
elif not packages_ok:
    print("\n[WARNING] OPTIONAL PACKAGES MISSING\n")
    print("Note: win10toast has optional dependencies")
    print("Notifications will be disabled but pipeline will still work")
    print("\n[OK] CONTINUE TO SETUP\n")
    sys.exit(0)
else:
    print("\n[OK] READY TO RUN\n")
    print("Next step: Register scheduled task with PowerShell (as Administrator)")
    print("\ncd telegram")
    print(r"Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope CurrentUser -Force")
    print(r".\setup_scheduled_task.ps1")
    sys.exit(0)
