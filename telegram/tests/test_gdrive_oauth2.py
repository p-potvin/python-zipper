#!/usr/bin/env python3
"""Test Google Drive OAuth2 Authentication"""

import os
import sys
import glob
from pathlib import Path

# Setup path
SCRIPT_DIR = Path(__file__).parent.absolute()
sys.path.insert(0, str(SCRIPT_DIR))

try:
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
    GOOGLE_DRIVE_AVAILABLE = True
except ImportError as e:
    print(f"[FAIL] Google Drive API not available: {e}")
    GOOGLE_DRIVE_AVAILABLE = False
    sys.exit(1)

def get_google_drive_service():
    """Authenticate with Google Drive using OAuth2 or Service Account"""
    if not GOOGLE_DRIVE_AVAILABLE:
        print("[WARN] Google Drive API not available")
        return None
    
    try:
        # Path: telegram/ -> python-scripts/ -> Github Repos/ -> .access/
        access_dir = os.path.join(os.path.dirname(os.path.dirname(SCRIPT_DIR)), ".access")
        print(f"[INFO] Access dir: {access_dir}")
        
        # Try service account first
        service_account_files = [
            os.path.join(access_dir, "service-account.json"),
            os.path.join(access_dir, "gdrive-service-account.json"),
        ]
        
        print(f"\n[CHECK] Service Account Files:")
        for service_file in service_account_files:
            exists = "✓" if os.path.exists(service_file) else "✗"
            print(f"  {exists} {service_file}")
            
            if os.path.exists(service_file):
                try:
                    from google.oauth2.service_account import Credentials
                    creds = Credentials.from_service_account_file(
                        service_file,
                        scopes=['https://www.googleapis.com/auth/drive']
                    )
                    service = build('drive', 'v3', credentials=creds)
                    print(f"[OK] Service Account authenticated!")
                    return service
                except Exception as e:
                    print(f"[WARN] Service account failed: {e}")
        
        # Fallback to OAuth2
        print(f"\n[CHECK] OAuth2 Files:")
        oauth_pattern = os.path.join(access_dir, "*client_secret*.json")
        oauth_files = glob.glob(oauth_pattern)
        
        if oauth_files:
            oauth_file = oauth_files[0]
            print(f"  ✓ Found: {os.path.basename(oauth_file)}")
            print(f"    Path: {oauth_file}")
            
            try:
                from google_auth_oauthlib.flow import InstalledAppFlow
                from google.auth.transport.requests import Request
                from google.oauth2.credentials import Credentials as OAuthCredentials
                
                token_file = os.path.join(SCRIPT_DIR, ".gdrive_token.json")
                print(f"\n[INFO] Token cache: {token_file}")
                
                creds = None
                
                # Load existing token
                if os.path.exists(token_file):
                    print(f"[INFO] Loading cached token...")
                    creds = OAuthCredentials.from_authorized_user_file(token_file)
                    
                    if creds.expired and creds.refresh_token:
                        print(f"[INFO] Token expired, refreshing...")
                        creds.refresh(Request())
                
                # Request new auth if needed
                if not creds or not creds.valid:
                    print(f"\n[INFO] Requesting new authorization...")
                    print(f"[INFO] Opening browser for Google Sign-in...")
                    
                    flow = InstalledAppFlow.from_client_secrets_file(
                        oauth_file,
                        scopes=['https://www.googleapis.com/auth/drive']
                    )
                    
                    # Use run_local_server with open_browser=False to show auth code instead
                    creds = flow.run_local_server(port=0, open_browser=False)
                    
                    # Save token for future use
                    with open(token_file, 'w') as f:
                        import json
                        json.dump(json.loads(creds.to_json()), f)
                    print(f"[OK] Token saved for future use")
                
                service = build('drive', 'v3', credentials=creds)
                print(f"[OK] OAuth2 authenticated!")
                return service
                
            except Exception as e:
                print(f"[FAIL] OAuth2 auth failed: {e}")
                import traceback
                traceback.print_exc()
                return None
        else:
            print(f"  ✗ No OAuth2 files found")
        
        print(f"\n[FAIL] No Google Drive credentials found")
        return None
        
    except Exception as e:
        print(f"[FAIL] Error: {e}")
        import traceback
        traceback.print_exc()
        return None

def test_drive_access(service):
    """Test basic Drive access"""
    try:
        print(f"\n[TEST] Checking Google Drive access...")
        result = service.about().get(fields='storageQuota, user').execute()
        
        user = result.get('user', {})
        storage = result.get('storageQuota', {})
        
        email = user.get('emailAddress', 'unknown')
        total_gb = int(storage.get('limit', 0)) / (1024**3)
        used_gb = int(storage.get('usage', 0)) / (1024**3)
        free_gb = (int(storage.get('limit', 0)) - int(storage.get('usage', 0))) / (1024**3)
        
        print(f"[OK] Account: {email}")
        print(f"[OK] Storage: {used_gb:.2f}GB used / {total_gb:.2f}GB total")
        print(f"[OK] Available: {free_gb:.2f}GB free")
        
        return True
    except Exception as e:
        print(f"[FAIL] Drive access error: {e}")
        return False

def test_file_upload(service):
    """Test file upload"""
    try:
        print(f"\n[TEST] Testing file upload...")
        
        # Create test file
        test_file = os.path.join(SCRIPT_DIR, "_test_gdrive_upload.txt")
        with open(test_file, 'w') as f:
            f.write("Test file for Google Drive OAuth2\n")
            f.write(f"Created: {__file__}\n")
        
        print(f"[INFO] Test file: {test_file}")
        
        # Upload
        file_metadata = {
            'name': 'test_telethon_pipeline.txt',
            'description': 'Test file from Telethon pipeline'
        }
        
        media = MediaFileUpload(test_file, mimetype='text/plain')
        
        file = service.files().create(
            body=file_metadata,
            media_body=media,
            fields='id, webViewLink, name, createdTime'
        ).execute()
        
        file_id = file.get('id')
        file_url = file.get('webViewLink')
        
        print(f"[OK] Upload successful!")
        print(f"[OK] File ID: {file_id}")
        print(f"[OK] File URL: {file_url}")
        
        # Share file
        print(f"[INFO] Making file accessible...")
        service.permissions().create(
            fileId=file_id,
            body={'type': 'anyone', 'role': 'reader'}
        ).execute()
        
        print(f"[OK] File is now shared (anyone with link can view)")
        
        # Cleanup: delete test file
        try:
            service.files().delete(fileId=file_id).execute()
            print(f"[OK] Cleaned up test file from Drive")
        except:
            print(f"[WARN] Could not delete test file (cleanup manually if needed)")
        
        # Remove local test file
        try:
            os.remove(test_file)
        except:
            pass
        
        return True
        
    except Exception as e:
        print(f"[FAIL] Upload test failed: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == '__main__':
    print("=" * 70)
    print("Google Drive OAuth2 Authentication Test")
    print("=" * 70)
    
    service = get_google_drive_service()
    
    if service:
        print(f"\n[SUCCESS] Google Drive service authenticated\n")
        
        # Test Drive access
        if test_drive_access(service):
            # Test file upload
            if test_file_upload(service):
                print(f"\n" + "=" * 70)
                print(f"[===] READY FOR PRODUCTION [===]")
                print(f"=" * 70)
            else:
                print(f"\n[WARN] Upload test failed")
        else:
            print(f"\n[WARN] Drive access test failed")
    else:
        print(f"\n[FAILED] Could not authenticate")
        sys.exit(1)
