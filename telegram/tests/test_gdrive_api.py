#!/usr/bin/env python3
"""Test Google Drive API Key Authentication"""

import os
import sys
from pathlib import Path

# Setup path
SCRIPT_DIR = Path(__file__).parent.absolute()
sys.path.insert(0, str(SCRIPT_DIR))

try:
    from googleapiclient.discovery import build
    GOOGLE_DRIVE_AVAILABLE = True
except ImportError as e:
    print(f"[FAIL] Google Drive API not available: {e}")
    GOOGLE_DRIVE_AVAILABLE = False
    sys.exit(1)

def get_google_drive_service():
    """Authenticate and get Google Drive service using API key"""
    try:
        # Path: telegram/ -> python-scripts/ -> Github Repos/ -> .access/
        api_key_path = os.path.join(os.path.dirname(os.path.dirname(SCRIPT_DIR)), ".access", "googledrive_api.txt")
        print(f"[INFO] Looking for API key at: {api_key_path}")
        
        if not os.path.exists(api_key_path):
            print(f"[FAIL] Google Drive API key not found at {api_key_path}")
            return None
        
        # Read API key from file
        with open(api_key_path, 'r') as f:
            api_key = f.read().strip()
        
        if not api_key:
            print("[FAIL] Google Drive API key is empty")
            return None
        
        print(f"[OK] API key loaded: {api_key[:20]}...")
        print(f"[INFO] Initializing Google Drive Service (v3)...")
        service = build('drive', 'v3', developerKey=api_key)
        
        # Test the service with a simple API call
        try:
            print("[INFO] Testing API authentication...")
            result = service.about().get(fields='storageQuota').execute()
            
            storage_quota = result.get('storageQuota', {})
            limit_bytes = int(storage_quota.get('limit', 0))
            usage_bytes = int(storage_quota.get('usage', 0))
            
            limit_gb = limit_bytes / (1024**3)
            usage_gb = usage_bytes / (1024**3)
            free_gb = (limit_bytes - usage_bytes) / (1024**3)
            
            print(f"[OK] Google Drive API authenticated successfully")
            print(f"\n[STORAGE QUOTA]")
            print(f"  Total:     {limit_gb:.2f} GB")
            print(f"  Used:      {usage_gb:.2f} GB ({(usage_bytes/limit_bytes)*100:.1f}%)")
            print(f"  Available: {free_gb:.2f} GB")
            
            return service
            
        except Exception as e:
            print(f"[FAIL] API test failed: {e}")
            return None
        
    except Exception as e:
        print(f"[FAIL] Error: {e}")
        import traceback
        traceback.print_exc()
        return None

def test_file_upload(service):
    """Test file upload capability"""
    if not service:
        print("[SKIP] Skipping upload test (no service)")
        return False
    
    try:
        print("\n[TEST] File Upload Capability")
        
        # Create a small test file
        test_file = os.path.join(SCRIPT_DIR, "test_gdrive_upload.txt")
        with open(test_file, 'w') as f:
            f.write("Test file for Google Drive API\n")
        
        print(f"[INFO] Created test file: {test_file}")
        
        # Try to create a file via API
        from googleapiclient.http import MediaFileUpload
        
        file_metadata = {
            'name': 'gdrive_api_test.txt',
            'mimeType': 'text/plain'
        }
        
        print("[INFO] Attempting to upload test file to Google Drive...")
        media = MediaFileUpload(test_file, mimetype='text/plain')
        
        try:
            file = service.files().create(
                body=file_metadata,
                media_body=media,
                fields='id, webViewLink, name'
            ).execute()
            
            print(f"[OK] Upload successful!")
            print(f"  File ID:  {file.get('id')}")
            print(f"  File URL: {file.get('webViewLink')}")
            print(f"  Filename: {file.get('name')}")
            
            # Try to delete the test file
            try:
                service.files().delete(fileId=file.get('id')).execute()
                print(f"[OK] Cleaned up test file from Drive")
            except:
                print(f"[WARN] Could not delete test file (might need manual cleanup)")
            
            return True
            
        except Exception as e:
            print(f"[WARN] Upload test failed: {e}")
            print("[INFO] This API key might not have upload permissions")
            return False
            
    except Exception as e:
        print(f"[FAIL] Upload test error: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        # Clean up test file
        try:
            if os.path.exists(test_file):
                os.remove(test_file)
        except:
            pass

if __name__ == '__main__':
    print("=" * 60)
    print("Google Drive API Key Authentication Test")
    print("=" * 60)
    
    service = get_google_drive_service()
    
    if service:
        print("\n[SUCCESS] Google Drive API Ready")
        print("[TEST] Testing upload capability...")
        upload_ok = test_file_upload(service)
        
        if upload_ok:
            print("\n[===] READY FOR PRODUCTION [===]")
        else:
            print("\n[===] READ-ONLY API (no upload) [===]")
    else:
        print("\n[FAILED] Could not authenticate with Google Drive")
        sys.exit(1)
