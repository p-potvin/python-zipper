#!/usr/bin/env python3
"""Test if desktop application OAuth2 works without redirect_uri registration"""

import sys
import os

# Add parent to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ['PYTHONIOENCODING'] = 'utf-8'

print("\n" + "="*80)
print("TESTING DESKTOP APPLICATION OAUTH2 FLOW")
print("="*80)

# Check which credentials file will be used
# Go up 3 dirs from telegram folder to reach Github Repos root
access_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".access")
new_oauth = os.path.join(access_dir, "mega-to-gdrive-oauth.json")
old_oauth_pattern = os.path.join(access_dir, "*client_secret*.json")

print(f"\n[1] Checking credentials files:")
print(f"    New file: {new_oauth}")
print(f"    Exists: {os.path.exists(new_oauth)}")

if os.path.exists(new_oauth):
    print(f"    [OK] Will use: mega-to-gdrive-oauth.json")
    with open(new_oauth) as f:
        import json
        creds = json.load(f)
        app_type = "installed" if "installed" in creds else "web"
        print(f"    App type: {app_type} (good for desktop app!)")
else:
    print(f"    [FAIL] File not found!")

if __name__ == '__main__':
    # Now try running process_unrestricted_links
    print(f"\n[2] Starting process_unrestricted_links.py...")
    print("-"*80)

    # Remove old token to force re-auth
    token_file = os.path.join(os.path.dirname(__file__), ".gdrive_token.json")
    if os.path.exists(token_file):
        os.remove(token_file)
        print(f"    Removed old token file")

    try:
        from process_unrestricted_links import process_unrestricted_links
        import asyncio
        asyncio.run(process_unrestricted_links())
        print("\n[OK] Process completed!")
    except KeyboardInterrupt:
        print("\n[USER] Interrupted")
    except ImportError:
        print("\n[WARN] process_unrestricted_links.py not found (deprecated / migrated).")
    except Exception as e:
        print(f"\n[FAIL] Error: {e}")
        import traceback
        traceback.print_exc()

