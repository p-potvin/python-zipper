#!/usr/bin/env python3
"""Check Google Drive OAuth2 Setup"""

import os
import sys
import json
import glob
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.absolute()

def check_oauth_setup():
    """Check if OAuth2 is properly configured"""
    access_dir = os.path.join(os.path.dirname(os.path.dirname(SCRIPT_DIR)), ".access")
    
    print("=" * 70)
    print("Google Drive OAuth2 Setup Verification")
    print("=" * 70)
    
    print(f"\n[CHECK] Looking in: {access_dir}\n")
    
    # Check for service account
    print("[1] Service Account Files:")
    service_accounts = [
        "service-account.json",
        "gdrive-service-account.json"
    ]
    
    has_service_account = False
    for f in service_accounts:
        path = os.path.join(access_dir, f)
        status = "[OK]" if os.path.exists(path) else "[MISS]"
        print(f"    {status} {f}")
        if os.path.exists(path):
            has_service_account = True
    
    # Check for OAuth2 credentials
    print("\n[2] OAuth2 Client Secret Files:")
    oauth_pattern = os.path.join(access_dir, "*client_secret*.json")
    oauth_files = glob.glob(oauth_pattern)
    
    if oauth_files:
        for f in oauth_files:
            print(f"    [OK] {os.path.basename(f)}")
            
            # Try to parse it
            try:
                with open(f, 'r') as fh:
                    oauth_data = json.load(fh)
                    
                    # Validate OAuth2 structure
                    if 'installed' in oauth_data:
                        cli = oauth_data['installed']
                        client_id = cli.get('client_id', 'N/A')
                        
                        print(f"        Client ID: {client_id[:30]}...")
                        print(f"        Auth URI: {cli.get('auth_uri', 'N/A')}")
                        print(f"        Token URI: {cli.get('token_uri', 'N/A')}")
                        print(f"        [OK] Valid OAuth2 structure")
                    else:
                        print(f"        [WARN] Missing 'installed' key")
            except Exception as e:
                print(f"        [FAIL] Could not parse: {e}")
    else:
        print(f"    [MISS] No client_secret files found")
    
    # Summary
    print(f"\n[SUMMARY]")
    print(f"    Service Account: {'Available' if has_service_account else 'Not found'}")
    print(f"    OAuth2 Credentials: {'Available' if oauth_files else 'Not found'}")
    
    if oauth_files or has_service_account:
        print(f"\n[OK] Google Drive credentials ready!")
        print(f"\nNext steps:")
        print(f"1. Pipeline will use OAuth2 on first run")
        print(f"2. Browser window opens for Google Sign-in")
        print(f"3. Token auto-saved for future runs")
        print(f"4. No manual intervention needed")
        return True
    else:
        print(f"\n[WARN] No Google Drive credentials found")
        print(f"\nSetup required:")
        print(f"1. Go to: https://console.cloud.google.com")
        print(f"2. Create OAuth2 Desktop Credentials")
        print(f"3. Download client_secret_*.json")
        print(f"4. Place in: {access_dir}")
        return False

if __name__ == '__main__':
    success = check_oauth_setup()
    sys.exit(0 if success else 1)
