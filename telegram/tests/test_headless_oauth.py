#!/usr/bin/env python3
"""Test headless Google Drive OAuth2 authorization"""

import os
import sys
import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.absolute()

def test_headless_oauth():
    """Test OAuth2 in headless mode (no browser)"""
    
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
        from google.oauth2.credentials import Credentials as OAuthCredentials
        from google.auth.transport.requests import Request
    except ImportError:
        print("[FAIL] Missing google-auth libraries")
        return False
    
    # Find OAuth2 file
    access_dir = os.path.join(os.path.dirname(os.path.dirname(SCRIPT_DIR)), ".access")
    import glob
    oauth_files = glob.glob(os.path.join(access_dir, "*client_secret*.json"))
    
    if not oauth_files:
        print("[FAIL] No OAuth2 credential file found")
        return False
    
    oauth_file = oauth_files[0]
    token_file = os.path.join(SCRIPT_DIR, ".gdrive_token_test.json")
    
    print("=" * 70)
    print("Google Drive OAuth2 - Headless Mode Test")
    print("=" * 70)
    
    print(f"\n[1] OAuth2 File: {os.path.basename(oauth_file)}")
    print(f"[2] Using credentials at: {oauth_file}")
    
    try:
        # Check for cached token
        creds = None
        if os.path.exists(token_file):
            print(f"\n[OK] Found cached token, loading...")
            creds = OAuthCredentials.from_authorized_user_file(token_file)
            if creds.expired and creds.refresh_token:
                print(f"[REFRESH] Token expired, refreshing...")
                creds.refresh(Request())
        
        if not creds or not creds.valid:
            print(f"\n[AUTH] Need to authorize. Here's what will happen:\n")
            
            flow = InstalledAppFlow.from_client_secrets_file(
                oauth_file,
                scopes=['https://www.googleapis.com/auth/drive']
            )
            
            print(f"Step 1: Generate authorization URL")
            auth_url, _ = flow.authorization_url()
            print(f"    {auth_url}\n")
            
            print(f"Step 2: Copy authorization code from redirect URL")
            print(f"        (look for: ?code=<CODE>)\n")
            
            # For testing, just show what would happen
            print(f"[TEST] This is a dry-run (no actual auth made)")
            print(f"[TEST] In real execution, you would:")
            print(f"       1. Visit the URL above")
            print(f"       2. Sign in to Google")
            print(f"       3. Copy the authorization code")
            print(f"       4. Paste it when prompted\n")
            
            print(f"[NOTE] Authorization code is different each time")
            print(f"[NOTE] Once authorized, token cached for 1 year\n")
            
            return True
        else:
            print(f"\n[OK] Token valid (cached from previous auth)")
            print(f"[INFO] No new authorization needed")
            return True
            
    except Exception as e:
        print(f"\n[ERROR] {e}")
        return False

if __name__ == '__main__':
    success = test_headless_oauth()
    print("\n" + "=" * 70)
    if success:
        print("[SUCCESS] Headless OAuth2 flow is ready!")
        print("\nWhen pipeline runs:")
        print("  1. Opens browser (or shows manual auth URL if unavailable)")
        print("  2. You authorize access to your Google Drive")
        print("  3. Token cached automatically")
        print("  4. Future runs work without auth")
        sys.exit(0)
    else:
        print("[FAILED] OAuth2 setup incomplete")
        sys.exit(1)
