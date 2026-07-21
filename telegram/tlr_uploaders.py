"""
Background uploaders and Google Drive helpers extracted from telethon_link_resolver.py.
"""

import os
import asyncio
import datetime
import random


async def background_katfile_uploader(current_run_files, output_dir, katfile_daily_limit,
                                       get_katfile_daily_uploaded_size_fn, upload_local_with_fallbacks_fn):
    """
    Uploads files downloaded during this run to Katfile in parallel (up to 3 concurrent uploads).
    Falls back to Gofile, K2S/FileBoom, then Katfile.
    """
    files = [f for f in current_run_files if os.path.isfile(f)]
    if not files:
        print(f"[BG Uploader] No files from this run to upload.")
        return

    print(f"[BG Uploader] Starting background uploader for {len(files)} files from this run...")
    random.shuffle(files)

    active_uploads = []
    max_concurrent_uploads = 3

    for idx, file_path in enumerate(files, 1):
        file_size = os.path.getsize(file_path)

        uploaded_today = get_katfile_daily_uploaded_size_fn()
        if uploaded_today + file_size > katfile_daily_limit:
            if uploaded_today >= katfile_daily_limit:
                print(f"[BG Uploader] [WARN] Daily Katfile limit of {katfile_daily_limit / (1024**3):.2f} GB reached. Stopping background uploads.")
                break
            print(f"[BG Uploader] [SKIP] File {os.path.basename(file_path)} would exceed daily Katfile limit. Skipping.")
            continue

        while len(active_uploads) >= max_concurrent_uploads:
            active_uploads = [t for t in active_uploads if not t.done()]
            await asyncio.sleep(1)

        print(f"[BG Uploader] Scheduling upload: {os.path.basename(file_path)}")
        task = asyncio.get_running_loop().run_in_executor(
            None,
            upload_local_with_fallbacks_fn,
            file_path,
            idx
        )
        active_uploads.append(task)
        await asyncio.sleep(2)

    if active_uploads:
        print(f"[BG Uploader] Waiting for remaining background uploads to finish...")
        await asyncio.gather(*active_uploads, return_exceptions=True)
    print(f"[BG Uploader] [WARN] Background uploader finished.")


async def background_dual_uploader(current_run_files, output_dir,
                                    is_token_valid_fn, upload_file_dual_fn,
                                    register_mirror_fn):
    """
    Uploads files to FileBoom/Keep2Share in parallel (up to 3 concurrent uploads).
    Appends links to logs/uploads_log.txt.
    """
    if not is_token_valid_fn():
        print("[BG Dual Uploader] ✗ Keep2Share/FileBoom token is invalid or expired. Skipping dual uploader.")
        return

    all_files = [f for f in current_run_files if os.path.isfile(f)]
    files = []
    for f in all_files:
        name = os.path.basename(f)
        if name.startswith('.') or name.endswith('.incomplete') or name.endswith('.trickplay') or name.endswith('.torrents'):
            continue
        files.append(f)

    if not files:
        print(f"[BG Dual Uploader] No valid upload candidates from this run.")
        return

    print(f"[BG Dual Uploader] Starting background dual uploader for {len(files)} files...")
    random.shuffle(files)

    active_uploads = []
    max_concurrent_uploads = 3

    def run_upload(file_path):
        filename = os.path.basename(file_path)
        file_size = os.path.getsize(file_path)
        try:
            res = upload_file_dual_fn(file_path)
            if res and res.get("link"):
                log_path = os.path.join(output_dir, "uploads_log.txt")
                now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                size_gb = file_size / (1024**3)
                log_line = f"[{now_str}] {filename} ({size_gb:.2f} GB) → {res['service']}"
                if res.get('instant'):
                    log_line += " (INSTANT)"
                log_line += f" | Link: {res['link']}\n"

                with open(log_path, 'a', encoding='utf-8') as lf:
                    lf.write(log_line)
                print(f"[BG Dual Uploader] [OK] [{res['service']}] Uploaded {filename} -> {res['link']}")

                register_mirror_fn(filename, res['link'])
                return True
            else:
                print(f"[BG Dual Uploader] [FAIL] Failed to upload {filename}")
                return False
        except Exception as e:
            print(f"[BG Dual Uploader] [FAIL] Exception uploading {filename}: {e}")
            return False

    for idx, file_path in enumerate(files, 1):
        while len(active_uploads) >= max_concurrent_uploads:
            active_uploads = [t for t in active_uploads if not t.done()]
            await asyncio.sleep(1)

        print(f"[BG Dual Uploader] Scheduling dual upload: {os.path.basename(file_path)}")
        task = asyncio.get_running_loop().run_in_executor(
            None,
            run_upload,
            file_path
        )
        active_uploads.append(task)
        await asyncio.sleep(2)

    if active_uploads:
        print(f"[BG Dual Uploader] Waiting for remaining background dual uploads to finish...")
        await asyncio.gather(*active_uploads, return_exceptions=True)
    print(f"[BG Dual Uploader] [WARN] Background dual uploader finished.")


def get_google_drive_service(script_dir):
    """Authenticate with Google Drive using OAuth2 or Service Account"""
    try:
        from googleapiclient.discovery import build

        access_dir = os.path.join(os.path.dirname(os.path.dirname(script_dir)), ".access")

        service_account_files = [
            os.path.join(access_dir, "service-account.json"),
            os.path.join(access_dir, "gdrive-service-account.json"),
        ]

        for service_file in service_account_files:
            if os.path.exists(service_file):
                try:
                    from google.oauth2.service_account import Credentials
                    creds = Credentials.from_service_account_file(
                        service_file,
                        scopes=['https://www.googleapis.com/auth/drive']
                    )
                    service = build('drive', 'v3', credentials=creds)
                    print(f"[OK] Google Drive authenticated via Service Account")
                    return service
                except Exception as e:
                    print(f"[WARN] Service account auth failed: {e}")

        import glob
        oauth_file = None

        new_oauth = os.path.join(access_dir, "mega-to-gdrive-oauth.json")
        if os.path.exists(new_oauth):
            oauth_file = new_oauth
            print(f"[OAUTH2] Using: {new_oauth}")
        else:
            oauth_pattern = os.path.join(access_dir, "*client_secret*.json")
            oauth_files = glob.glob(oauth_pattern)
            if oauth_files:
                oauth_file = oauth_files[0]
                print(f"[OAUTH2] Using: {oauth_file}")

        if oauth_file:
            try:
                from google_auth_oauthlib.flow import InstalledAppFlow
                from google.auth.transport.requests import Request
                from google.oauth2.credentials import Credentials as OAuthCredentials

                token_file = os.path.join(script_dir, ".gdrive_token.json")
                creds = None

                if os.path.exists(token_file):
                    creds = OAuthCredentials.from_authorized_user_file(token_file)
                    if creds.expired and creds.refresh_token:
                        creds.refresh(Request())

                if not creds or not creds.valid:
                    flow = InstalledAppFlow.from_client_secrets_file(
                        oauth_file,
                        scopes=['https://www.googleapis.com/auth/drive']
                    )

                    print(f"\n[OAUTH2] Starting authorization flow...")
                    auth_success = False

                    try:
                        print(f"\n[OAUTH2] Using out-of-band flow (manual code entry)...")
                        creds = flow.run_local_server(port=8888, open_browser=True, timeout_seconds=120)
                        auth_success = True
                    except Exception as e:
                        print(f"[OAUTH2] Local server failed: {str(e)[:100]}")
                        try:
                            print(f"\n[OAUTH2] Falling back to manual browser entry...")
                            auth_url, state = flow.authorization_url()
                            print(f"\n[STEP 1] Copy and visit this URL in your browser:")
                            print(f"    {auth_url}")
                            auth_code = input("Enter the authorization code: ").strip()
                            if auth_code:
                                creds = flow.fetch_token(code=auth_code)
                                auth_success = True
                        except Exception as e2:
                            print(f"[OAUTH2] Manual flow failed: {str(e2)[:100]}")

                    if creds and auth_success:
                        with open(token_file, 'w') as f:
                            import json
                            if hasattr(creds, 'to_json'):
                                json.dump(json.loads(creds.to_json()), f)
                            else:
                                json.dump(creds, f)
                        print(f"[OAUTH2] Token saved: {token_file}")
                    elif not auth_success:
                        print(f"[OAUTH2] ✗ Authorization failed")
                        return None

                service = build('drive', 'v3', credentials=creds)
                print(f"[OK] Google Drive authenticated via OAuth2")
                return service

            except Exception as e:
                print(f"[WARN] OAuth2 auth failed: {e}")

        print("[WARN] No Google Drive credentials found")
        return None

    except Exception as e:
        print(f"[WARN] Error loading Google Drive service: {e}")
        import traceback
        traceback.print_exc()
        return None


def upload_to_google_drive(file_path, filename, drive_service, item_idx, original_url="",
                            generate_safe_filename_fn=None, add_file_extension_fn=None):
    """Upload file to Google Drive with improved naming"""
    if not drive_service:
        return None

    try:
        if not filename or filename.startswith('download_'):
            if generate_safe_filename_fn:
                better_name = generate_safe_filename_fn(original_url, prefix="content")
                filename = better_name

        if add_file_extension_fn:
            filename = add_file_extension_fn(filename, original_url)

        print(f"   [{item_idx}] Uploading to Google Drive: {filename}")

        from googleapiclient.http import MediaFileUpload

        file_metadata = {'name': filename}
        media = MediaFileUpload(file_path, resumable=True)

        file = drive_service.files().create(
            body=file_metadata,
            media_body=media,
            fields='id, webViewLink, name'
        ).execute()

        drive_url = file.get('webViewLink')
        print(f"   [{item_idx}] [OK] Uploaded to Google Drive")
        print(f"   [{item_idx}]   URL: {drive_url}")

        return {
            'drive_url': drive_url,
            'file_id': file.get('id'),
            'filename': filename
        }
    except Exception as e:
        print(f"   [{item_idx}] [FAIL] Google Drive upload error: {e}")
        return None
