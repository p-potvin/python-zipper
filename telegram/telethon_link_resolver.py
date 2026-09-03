import os
import sys
import asyncio
import datetime
from urllib.parse import quote
from telethon import TelegramClient
from telethon.tl.types import MessageEntityUrl, MessageEntityTextUrl
from patchright.async_api import async_playwright

# Ensure UTF-8 output encoding for Windows CP1252 terminals
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

# --- PROXY PATCHING FOR REQUESTS ---
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
try:
    import proxy_utils
    import requests
    _proxy_dict = proxy_utils.get_requests_proxies()
    if _proxy_dict:
        _old_request = requests.Session.request
        def _new_request(self, method, url, **kwargs):
            if "proxies" not in kwargs and not str(url).startswith("http://127.0.0.1") and not str(url).startswith("http://localhost"):
                kwargs["proxies"] = _proxy_dict
            return _old_request(self, method, url, **kwargs)
        requests.Session.request = _new_request
except ImportError:
    pass
# -----------------------------------

from k2s_uploader import upload_file_dual, is_token_valid
from uploaders import (
    upload_to_katfile, upload_local_with_fallbacks,
    register_mirror_in_link_sharing,
    get_katfile_daily_uploaded_size, can_upload_to_katfile,
)
from site_downloaders import get_handler

# --- Extracted modules ---
from tlr_utils import (
    resolve_initial_url, send_notification,
    guess_file_extension_from_url, generate_safe_filename, add_file_extension_to_name,
)
from tlr_linkvertise import (
    bypass_linkvertise_in_browser, extract_mega_from_rentry, extract_links_from_rentry,
)
from tlr_realdebrid import (
    unrestrict_mega_with_realdebrid, expand_mega_folder,
    mega_folder_rd_extension_automation,
)
from tlr_uploaders import (
    background_katfile_uploader, background_dual_uploader,
    get_google_drive_service, upload_to_google_drive,
)
from tlr_browser import (
    download_file_with_browser, solve_specific_captcha, resolve_url_with_browser,
)
from tlr_url_classifier import (
    convert_bunkr_link, normalize_url, classify_and_filter_url,
    check_pyload_api, queue_links_to_pyload,
)
from tlr_pipeline import (
    process_direct_downloads, process_rd_links, process_mega_links_with_alldebrid,
)
from tlr_alldebrid import clean_telegram_first_line

from tlr_config import (
    SCRIPT_DIR, API_ID, API_HASH, CHANNEL_NAME, MESSAGE_LIMIT, MESSAGE_SKIP,
    OUTPUT_DIR, ARTIFACTS_DIR, SESSIONS_DIR, ASSETS_DIR, OUTPUT_FILE, SESSION_NAME,
    BROWSER_PROFILE_DIR, RIP_API_KEY, RIP_API_ENDPOINT,
    FIREFOX_AVAILABLE, CHROME_AVAILABLE,
    REALDEBRID_API_TOKEN, REALDEBRID_API_BASE,
    ALLDEBRID_API_KEY, ALLDEBRID_API_BASE, PLAYLISTS_DIR,
    KATFILE_API_KEY, KATFILE_API_BASE, KATFILE_UPLOAD_SERVER_ENDPOINT, KATFILE_DOMAIN,
    PIXELDRAIN_KEY, ONEFICHIER_KEY, GOFILE_KEY,
    PYLOAD_API_URL, PYLOAD_API_KEY, PYLOAD_ENABLED,
    DOWNLOAD_DIR, _current_run_files,
    MAX_FILESIZE_UPLOAD, MAX_FILESIZE_DOWNLOAD, LARGE_FILE_DOWNLOAD_DIR,
    KATFILE_DAILY_LIMIT, KATFILE_UPLOAD_DIR,
)

async def main():
    import argparse
    import sys
    
    parser = argparse.ArgumentParser(description="Telethon Scraper Link Resolver")
    parser.add_argument("--non-interactive", action="store_true", default=None, help="Run in non-interactive mode")
    args, unknown = parser.parse_known_args()
    
    if args.non_interactive is None:
        args.non_interactive = not sys.stdin.isatty()
        if args.non_interactive:
            print("[INFO] Stdin is not a TTY. Automatically enabling --non-interactive mode.")
            
    print(f"[{datetime.datetime.now()}] Starting Telethon scraper with RIP Linkvertise API...")
    print(f"[INFO] Available browsers: Firefox={FIREFOX_AVAILABLE}, Chrome={CHROME_AVAILABLE}")
    print(f"[INFO] Download directory: {DOWNLOAD_DIR}")
    
    # Initialize the Telethon client
    client = TelegramClient(SESSION_NAME, API_ID, API_HASH)
    await client.start() # type: ignore
    
    # Populate the internal entity cache so that bare integer IDs can be resolved
    print("Fetching dialogs to populate entity cache...")
    await client.get_dialogs()
    
    # Handle both single channel (string) and multiple channels (tuple)
    channels = CHANNEL_NAME if isinstance(CHANNEL_NAME, tuple) else (CHANNEL_NAME,)
    print(f"Connected to Telegram! Fetching from {len(channels)} channel(s): {channels}...")
    if MESSAGE_SKIP > 0:
        print(f"[INFO] Skipping first {MESSAGE_SKIP} messages per channel (MESSAGE_SKIP={MESSAGE_SKIP})")
    
    links = set()
    url_titles = {}  # Map URL -> clean Telegram post title (first line without emojis)
    failed_channels = []
    
    # Iterate through each channel and collect links
    for channel in channels:
        print(f"  Processing channel: {channel}")
        try:
            message_count = 0
            async for message in client.iter_messages(channel, limit=MESSAGE_LIMIT + MESSAGE_SKIP):
                message_count += 1
                if message_count <= MESSAGE_SKIP:
                    continue  # Skip first N messages
                if not message.text or not message.entities:
                    continue
                
                clean_title = clean_telegram_first_line(message.text)
                    
                # Telethon conveniently parses embedded links natively
                for entity, text in message.get_entities_text():
                    url = None
                    if isinstance(entity, MessageEntityUrl):
                        url = text
                    elif isinstance(entity, MessageEntityTextUrl):
                        url = entity.url
                        
                    if url:
                        links.add(url)
                        if clean_title:
                            url_titles[url] = clean_title
            print(f"    [OK] Found {message_count - MESSAGE_SKIP} valid messages from {channel}")
        except ValueError as e:
            error_msg = f"Channel error: {channel} - {str(e)}"
            print(f"    [FAIL] {error_msg}")
            failed_channels.append(channel)
            send_notification("Channel Error", error_msg, 15, output_dir=OUTPUT_DIR)
            continue
        except Exception as e:
            error_msg = f"Unexpected error on {channel}: {type(e).__name__}: {str(e)}"
            print(f"    [FAIL] {error_msg}")
            failed_channels.append(channel)
            send_notification("Pipeline Error", error_msg, 15, output_dir=OUTPUT_DIR)
            continue
    
    # Report results
    if failed_channels:
        print(f"\n[WARNING] Failed to process {len(failed_channels)} channel(s): {failed_channels}")
    
    if not links:
        msg = "No links found in the recent messages from any accessible channel."
        print(msg)
        send_notification("Pipeline Complete", msg, 10, output_dir=OUTPUT_DIR)
        return
        
    print(f"Found {len(links)} raw links! Classifying and resolving redirects...")
    
    linkvertise_links = {}  # Map .com -> .lol for tracking
    hub_links = set()  # pasterix/pastehill/rentry pages that contain download links
    direct_links_from_telegram = set()  # Direct download links (gofile, bunkr, mega, etc.)
    
    # Patterns for link-* redirectors that resolve to linkvertise
    link_redirector_patterns = ['link-hub', 'link-target', 'link-hub.net', 'link-target.net']
    
    for idx, raw_url in enumerate(links, 1):
        url_lower = raw_url.lower()
        
        # Check if it's a link-* redirector (resolves to linkvertise)
        is_link_redirector = any(p in url_lower for p in link_redirector_patterns)
        
        if is_link_redirector:
            # Resolve redirect to get the actual linkvertise URL
            actual_url = resolve_initial_url(raw_url)
            orig_title = url_titles.get(raw_url, "")
            if orig_title:
                url_titles[actual_url] = orig_title
            if 'linkvertise.com' in actual_url.lower():
                converted = actual_url.replace('linkvertise.com', 'linkvertise.lol')
                linkvertise_links[actual_url] = converted
                if orig_title:
                    url_titles[converted] = orig_title
                print(f"[{idx}/{len(links)}] Link redirector -> Linkvertise: {raw_url} -> {actual_url}")
            else:
                print(f"[{idx}/{len(links)}] Link redirector but didn't resolve to linkvertise: {raw_url} -> {actual_url}")
        elif 'linkvertise.com' in url_lower:
            converted = raw_url.replace('linkvertise.com', 'linkvertise.lol')
            linkvertise_links[raw_url] = converted
            orig_title = url_titles.get(raw_url, "")
            if orig_title:
                url_titles[converted] = orig_title
            print(f"[{idx}/{len(links)}] Found Linkvertise: {raw_url}")
        elif 'rentry.co' in url_lower or 'rentry.org' in url_lower:
            # Rentry pages — scrape directly for download links (skip utility pages)
            skip_patterns = ['/edit', '/raw', '/export-page', '/report-url', '/how', '/what', '/langs', '/request-login']
            if not any(p in url_lower for p in skip_patterns) and url_lower != 'https://rentry.co/' and url_lower != 'https://rentry.org/':
                hub_links.add(raw_url)
                print(f"[{idx}/{len(links)}] Found rentry hub page: {raw_url}")
        elif 'pasterix.com' in url_lower or 'pasterix.net' in url_lower or 'pastehill.com' in url_lower:
            # Hub pages — scrape for download links (skip navigation/utility pages)
            skip_patterns = ['/login', '/register', '/contact', '/archive', '/sitemap',
                             '/lang/', '/pages/', '/clone/', '/u/']
            if not any(p in url_lower for p in skip_patterns):
                hub_links.add(raw_url)
                print(f"[{idx}/{len(links)}] Found hub page (pasterix/pastehill): {raw_url}")
        else:
            # Check if it's a direct download link we can process
            action, processed_url = classify_and_filter_url(raw_url)
            if action in ('rd', 'direct', 'pyload'):
                direct_links_from_telegram.add(raw_url)
                print(f"[{idx}/{len(links)}] Found direct link ({action}): {raw_url}")
            else:
                print(f"[{idx}/{len(links)}] Ignored: {raw_url}")

    if not linkvertise_links and not hub_links and not direct_links_from_telegram:
        print("No processable links were found. Exiting.")
        return
        
    intermediate_file = os.path.join(OUTPUT_DIR, "linkvertise_links.txt")
    with open(intermediate_file, 'w', encoding='utf-8') as f:
        for link_com, link_lol in sorted(linkvertise_links.items()):
            f.write(f"{link_com}\n")
    print(f"Saved {len(linkvertise_links)} intermediate .com links to {intermediate_file}")
    
    # Save RIP bypass URLs for reference
    rip_bypass_file = os.path.join(OUTPUT_DIR, "rip_bypass_urls.txt")
    with open(rip_bypass_file, 'w', encoding='utf-8') as f:
        for link_com in sorted(linkvertise_links.keys()):
            encoded_url = quote(link_com, safe='')
            rip_url = f"{RIP_API_ENDPOINT}?url={encoded_url}&apikey={RIP_API_KEY}"
            f.write(f"{rip_url}\n")
    print(f"Saved {len(linkvertise_links)} RIP bypass URLs to {rip_bypass_file}")

    print(f"[EXTRACTION] Using browser-based RIP bypass to extract rentry.co links...")
    print(f"[INFO] Real-Debrid integration: {'ENABLED' if REALDEBRID_API_TOKEN else 'DISABLED (no token)'}")
    print(f"[INFO] Katfile upload: {'ENABLED' if KATFILE_API_KEY else 'DISABLED (no API key)'}")
    print(f"[INFO] Local downloads: {DOWNLOAD_DIR}")
    
    resolved = set()
    downloads = []

    # Use dedicated persistent browser profile (retains extensions, cookies, sessions across runs)
    user_data_dir = BROWSER_PROFILE_DIR
    print(f"[INFO] Using persistent browser profile: {user_data_dir}")
    print(f"[INFO] Extensions and sessions are retained between runs (no cloning).")

    async with async_playwright() as p:
        print(f"[INFO] Launching Chrome Persistent Context (for Real-Debrid Extension)...")
        browser = None
        
        # Inject proxy if available
        import sys
        sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
        try:
            import proxy_utils
            proxy_config = proxy_utils.get_patchright_proxy()
        except ImportError:
            proxy_config = None
        
        chrome_exe = None
        for candidate in [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe",
        ]:
            if os.path.exists(candidate):
                chrome_exe = candidate
                break

        artifacts_dir = r"G:\artifacts" if os.path.exists(r"G:\artifacts") else ARTIFACTS_DIR

        for attempt in range(1, 4):
            try:
                launch_kwargs = {
                    "headless": False,
                    "no_viewport": True,
                    "user_data_dir": user_data_dir,
                    "artifacts_dir": artifacts_dir,
                    "proxy": proxy_config
                }
                if chrome_exe:
                    launch_kwargs["executable_path"] = chrome_exe
                else:
                    launch_kwargs["channel"] = "chrome"

                browser = await p.chromium.launch_persistent_context(**launch_kwargs)
                break
            except Exception as launch_err:
                print(f"[WARN] Attempt {attempt}/3 to launch browser failed: {launch_err}")
                if attempt == 3:
                    raise launch_err
                await asyncio.sleep(2)
        

        # Check if browser is logged in to Real-Debrid
        print("[Real-Debrid] Checking login status...")
        check_page = await browser.new_page()
        try:
            await check_page.goto("https://real-debrid.com/login", wait_until="domcontentloaded", timeout=15000)
            if "login" in check_page.url:
                print("[Real-Debrid] ⚠️ NOT LOGGED IN! Real-Debrid unrestriction may fail for MEGA links.")
            else:
                print("[Real-Debrid] ✓ Already logged in.")
        except Exception as e:
            print(f"[Real-Debrid] [WARN] Could not verify login status: {e}")
        finally:
            await check_page.close()

        # Step 1: Scrape hub pages (rentry/pasterix/pastehill from Telegram) to extract linkvertise links
        # Utility URL patterns to skip when extracting links from hub pages
        utility_skip_patterns = ['/edit', '/raw', '/export-page', '/report-url', '/how', '/what',
                                 '/langs', '/request-login', '/login', '/register', '/contact',
                                 '/archive', '/sitemap', '/pages/', '/clone/', '/u/']
        
        print(f"\n[HUB SCRAPING] Opening {len(hub_links)} hub pages to extract linkvertise links...")
        for idx, hub_url in enumerate(sorted(hub_links), 1):
            print(f"[{idx}/{len(hub_links)}] Extracting links from: {hub_url}")
            extracted_links = await extract_links_from_rentry(hub_url, browser, idx)
            hub_title = url_titles.get(hub_url, "")
            for l in extracted_links:
                l_lower = l.lower()
                # Skip utility/navigation URLs (export-page, edit, raw, etc.)
                if any(p in l_lower for p in utility_skip_patterns):
                    continue
                # Skip bare domain roots
                if l_lower in ('https://rentry.co/', 'https://rentry.org/', 'https://rentry.co', 'https://rentry.org'):
                    continue
                if hub_title:
                    url_titles[l] = hub_title
                # Check for linkvertise links
                if 'linkvertise.com' in l_lower:
                    if l not in linkvertise_links:
                        converted = l.replace('linkvertise.com', 'linkvertise.lol')
                        linkvertise_links[l] = converted
                        if hub_title:
                            url_titles[converted] = hub_title
                        print(f"   [HUB] Found new linkvertise: {l}")
                elif any(p in l_lower for p in link_redirector_patterns):
                    # link-hub/link-target redirectors → resolve to linkvertise
                    actual = resolve_initial_url(l)
                    if 'linkvertise.com' in actual.lower() and actual not in linkvertise_links:
                        converted = actual.replace('linkvertise.com', 'linkvertise.lol')
                        linkvertise_links[actual] = converted
                        if hub_title:
                            url_titles[actual] = hub_title
                            url_titles[converted] = hub_title
                        print(f"   [HUB] Found link redirector -> linkvertise: {l} -> {actual}")
                # Also collect any direct download links found on hub pages
                else:
                    action, _ = classify_and_filter_url(l)
                    if action in ('rd', 'direct', 'pyload', 'mega'):
                        direct_links_from_telegram.add(l)
                        print(f"   [HUB] Found direct link ({action}): {l}")

        # Update linkvertise files with newly discovered links from hub pages
        if linkvertise_links:
            with open(intermediate_file, 'w', encoding='utf-8') as f:
                for link_com in sorted(linkvertise_links.keys()):
                    f.write(f"{link_com}\n")
            print(f"[INFO] Updated linkvertise_links.txt with {len(linkvertise_links)} total links")

        # Step 2: Bypass all linkvertise links (from Telegram + from hub pages) to get actual rentry pages
        rentry_links = {}  # Map linkvertise -> rentry link
        for idx, link_com in enumerate(linkvertise_links.keys(), 1):
            print(f"\n[{idx}/{len(linkvertise_links)}] Bypassing: {link_com}")
            rentry_link = await bypass_linkvertise_in_browser(link_com, browser, idx)
            if rentry_link:
                rentry_links[link_com] = rentry_link
                orig_title = url_titles.get(link_com, "")
                if orig_title:
                    url_titles[rentry_link] = orig_title
                print(f"   [OK] Got rentry link: {rentry_link}")
            else:
                print(f"   [FAIL] Failed to bypass")
        
        # Step 3: Scrape the actual rentry pages (from linkvertise bypass) to extract download links
        all_extracted_urls = set()
        
        # Add direct download links collected from Telegram messages and hub pages
        for url in direct_links_from_telegram:
            all_extracted_urls.add(url)
            resolved.add(url)
        if direct_links_from_telegram:
            print(f"\n[INFO] Added {len(direct_links_from_telegram)} direct links from Telegram/hub pages")
        
        # Scrape rentry pages (from linkvertise bypass) — these contain the actual download links
        if rentry_links:
            print(f"\n[EXTRACTION] Opening {len(rentry_links)} rentry pages to extract download links...")
            for idx, (linkvertise, rentry) in enumerate(rentry_links.items(), 1):
                print(f"[{idx}/{len(rentry_links)}] Extracting links from: {rentry}")
                extracted_links = await extract_links_from_rentry(rentry, browser, idx)
                rentry_title = url_titles.get(rentry, "") or url_titles.get(linkvertise, "")
                for l in extracted_links:
                    l_lower = l.lower()
                    # Skip utility/navigation URLs
                    if any(p in l_lower for p in utility_skip_patterns):
                        continue
                    if l_lower in ('https://rentry.co/', 'https://rentry.org/', 'https://rentry.co', 'https://rentry.org'):
                        continue
                    if rentry_title:
                        url_titles[l] = rentry_title
                    all_extracted_urls.add(l)
                    resolved.add(l)
                
        # Save all extracted links to file
        all_links_file = os.path.join(OUTPUT_DIR, "all_extracted_links.txt")
        with open(all_links_file, "w", encoding="utf-8") as f:
            for l in sorted(all_extracted_urls):
                f.write(l + "\n")
        print(f"\n[INFO] Saved {len(all_extracted_urls)} total extracted links to {all_links_file}")
        
        # Start the background uploader to run concurrently
        #bg_uploader_task = asyncio.create_task(background_katfile_uploader())
        #bg_dual_uploader_task = asyncio.create_task(background_dual_uploader())

        # Classify all links first (with deduplication)
        mega_links = []
        rd_links = []
        direct_links = []
        pyload_links = []
        seen_normalized = set()
        for url in sorted(all_extracted_urls):
            normalized = normalize_url(url)
            if normalized in seen_normalized:
                continue
            seen_normalized.add(normalized)
            action, processed_url = classify_and_filter_url(url)
            if action == 'skip':
                continue
            elif action == 'mega':
                mega_links.append(processed_url)
            elif action == 'pyload':
                pyload_links.append(processed_url)
            elif action == 'direct':
                direct_links.append(processed_url)
            elif action == 'rd':
                rd_links.append(processed_url)

        print(f"\n[CLASSIFICATION] MEGA (AllDebrid): {len(mega_links)} | RD: {len(rd_links)} | Direct: {len(direct_links)} | pyLoad: {len(pyload_links)} | Skipped/Duped: {len(all_extracted_urls) - len(mega_links) - len(rd_links) - len(direct_links) - len(pyload_links)}")

        # Send 20% of pyload-classified links to pyLoad in parallel with cloud uploads
        pyload_parallel_count = max(1, len(pyload_links) // 5) if pyload_links else 0
        pyload_parallel_links = pyload_links[:pyload_parallel_count]
        remaining_pyload_links = pyload_links[pyload_parallel_count:]

        if pyload_parallel_links:
            print(f"\n[pyLoad] Sending {pyload_parallel_count}/{len(pyload_links)} links to pyLoad in parallel with cloud uploads...")
            for i in range(0, len(pyload_parallel_links), 5):
                batch = pyload_parallel_links[i:i+5]
                batch_idx = (i // 5) + 1
                queue_links_to_pyload(batch, package_name=f"Parallel Batch {batch_idx}")

        # Write remaining pyload links to txt file (untouched, for manual review)
        failed_links_file = os.path.join(OUTPUT_DIR, "failed_links.txt")
        with open(failed_links_file, "w", encoding="utf-8") as f:
            for link in remaining_pyload_links:
                f.write(link + "\n")
        if remaining_pyload_links:
            print(f"[INFO] Written {len(remaining_pyload_links)} remaining pyLoad links to {failed_links_file}")

        failed_links = []

        # Process MEGA links via AllDebrid API and generate M3U streaming playlists
        if mega_links:
            process_mega_links_with_alldebrid(
                mega_links, downloads, failed_links,
                playlists_dir=PLAYLISTS_DIR,
                output_dir=OUTPUT_DIR,
                api_key=ALLDEBRID_API_KEY,
                url_titles=url_titles
            )

        # Process direct-download links via pipeline module
        await process_direct_downloads(
            direct_links, browser, downloads, failed_links,
            DOWNLOAD_DIR, _current_run_files,
            get_handler, upload_local_with_fallbacks,
            get_google_drive_service, upload_to_google_drive,
            script_dir=SCRIPT_DIR,
        )

        # Process RD-classified links via pipeline module
        if rd_links:
            await process_rd_links(
                rd_links, browser, downloads, failed_links, OUTPUT_DIR,
                DOWNLOAD_DIR, _current_run_files, args,
                mega_folder_rd_extension_automation,
                download_file_with_browser,
                upload_local_with_fallbacks,
                get_google_drive_service, upload_to_google_drive,
                upload_to_katfile, can_upload_to_katfile,
                KATFILE_API_KEY, KATFILE_UPLOAD_DIR,
                script_dir=SCRIPT_DIR,
            )

        await browser.close()
        
        # Write any failed links (RD couldn't unrestrict) to txt file
        if failed_links:
            with open(failed_links_file, "a", encoding="utf-8") as f:
                for link in failed_links:
                    f.write(link + "\n")
            print(f"\n[INFO] Written {len(failed_links)} failed RD links to {failed_links_file}")
                
        # Wait for the background uploader to finish
        print("\n[BG Uploader] Waiting for background uploader to complete...")
        await bg_uploader_task
        print("\n[BG Dual Uploader] Waiting for background dual uploader to complete...")
        await bg_dual_uploader_task
        

    
    # Append the resolved MEGA URLs to our output file (never erase existing links)
    with open(OUTPUT_FILE, 'a', encoding='utf-8') as f:
        for url in sorted(resolved):
            f.write(url + '\n')
    
    # Write upload/download log if Real-Debrid was used
    if downloads:
        upload_log = os.path.join(OUTPUT_DIR, "uploads_log.txt")
        with open(upload_log, 'a', encoding='utf-8') as f:  # Append mode to preserve history
            f.write(f"\n[{datetime.datetime.now()}] Batch Upload/Download ({len(downloads)} files)\n")
            f.write("=" * 80 + "\n\n")
            for i, dl in enumerate(downloads, 1):
                f.write(f"[{i}] {dl['filename']}\n")
                f.write(f"    MEGA: {dl['mega_url']}\n")
                f.write(f"    Size: {dl['size'] / (1024**3):.2f} GB\n")
                f.write(f"    Type: {dl.get('type', 'unknown')}\n")
                if dl.get('katfile_url'):
                    f.write(f"    Katfile: {dl['katfile_url']}\n")
                if dl.get('path'):
                    f.write(f"    Local Path: {dl['path']}\n")
                f.write("\n")
        print(f"\n[UPLOADS] Saved {len(downloads)} upload records to {upload_log}")
    
    # Summary and notifications
    print(f"\n[{datetime.datetime.now()}] Success! Saved {len(resolved)} MEGA URLs to {OUTPUT_FILE}.")
    
    if downloads:
        katfile_count = sum(1 for d in downloads if d.get('katfile_url'))
        large_file_count = sum(1 for d in downloads if d.get('type') == 'large_file')
        local_count = sum(1 for d in downloads if d.get('path') and d.get('type') not in ['large_file'])
        
        summary_parts = []
        if katfile_count > 0:
            summary_parts.append(f"Uploaded {katfile_count} files to Katfile")
            print(f"[{datetime.datetime.now()}] Uploaded {katfile_count} files to Katfile (< 3GB).")
        if large_file_count > 0:
            summary_parts.append(f"Downloaded {large_file_count} large files (3-10GB)")
            print(f"[{datetime.datetime.now()}] Downloaded {large_file_count} large files (3-10GB) to {LARGE_FILE_DOWNLOAD_DIR}.")
        if local_count > 0:
            summary_parts.append(f"Downloaded {local_count} files locally")
            print(f"[{datetime.datetime.now()}] Downloaded {local_count} files locally to {DOWNLOAD_DIR}.")
        
        # Send Windows notification
        if summary_parts:
            notification_msg = "\n".join(summary_parts)
            send_notification(
                "Telethon Pipeline Complete",
                notification_msg,
                duration=10,
                output_dir=OUTPUT_DIR,
            )
    else:
        send_notification("Telethon Pipeline", "No files to upload/download", duration=5, output_dir=OUTPUT_DIR)

if __name__ == '__main__':
    asyncio.run(main())

