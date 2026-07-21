"""
Pipeline processing functions extracted from telethon_link_resolver.py main().
Handles direct-download processing and Real-Debrid link processing.
"""

import os
import asyncio
import requests


async def process_direct_downloads(direct_links, browser, downloads, failed_links,
                                     download_dir, current_run_files,
                                     get_handler_fn, upload_local_with_fallbacks_fn,
                                     get_google_drive_service_fn, upload_to_google_drive_fn,
                                     script_dir=None):
    """Process direct-download links with site-specific handlers."""
    if not direct_links:
        return

    print(f"\n[DIRECT DOWNLOAD] Processing {len(direct_links)} links with site-specific handlers...")
    for idx, url in enumerate(direct_links, 1):
        print(f"\n[{idx}/{len(direct_links)}] Direct Download: {url}")
        handler = get_handler_fn(url)
        if not handler:
            print(f"   [WARN] No handler found for {url}, adding to failed_links")
            failed_links.append(url)
            continue

        page = await browser.new_page()
        try:
            local_path = await handler.download(page, url, download_dir, idx)
            if local_path and os.path.exists(local_path):
                current_run_files.add(local_path)
                file_size = os.path.getsize(local_path)
                file_size_mb = file_size / (1024 ** 2)
                file_size_gb = file_size / (1024 ** 3)

                if file_size < 25 * 1024 * 1024:
                    print(f"   [SKIP] File too small ({file_size_mb:.2f} MB < 25 MB), deleting")
                    os.remove(local_path)
                elif file_size > 2 * 1024 * 1024 * 1024:
                    print(f"   [SKIP] File too large ({file_size_gb:.2f} GB > 2 GB), deleting")
                    os.remove(local_path)
                else:
                    print(f"   [OK] Downloaded ({file_size_mb:.1f} MB), uploading to cloud...")
                    fallback_result = upload_local_with_fallbacks_fn(local_path, idx)
                    if fallback_result and fallback_result.get('url'):
                        downloads.append({
                            'mega_url': url,
                            'filename': os.path.basename(local_path),
                            'fallback_url': fallback_result['url'],
                            'size': file_size,
                            'type': 'direct_download'
                        })
                    else:
                        drive_service = get_google_drive_service_fn(script_dir) if script_dir else get_google_drive_service_fn()
                        if drive_service:
                            drive_result = upload_to_google_drive_fn(
                                local_path,
                                os.path.basename(local_path),
                                drive_service,
                                idx
                            )
                            if drive_result:
                                downloads.append({
                                    'mega_url': url,
                                    'filename': os.path.basename(local_path),
                                    'drive_url': drive_result.get('drive_url'),
                                    'size': file_size,
                                    'type': 'gdrive'
                                })
                            else:
                                print(f"   [WARN] All uploads failed, keeping local file")
                        else:
                            print(f"   [WARN] No Google Drive, keeping local file")

                    try:
                        if downloads and downloads[-1].get('type') in ('direct_download', 'gdrive'):
                            os.remove(local_path)
                    except Exception:
                        pass
            else:
                print(f"   [FAIL] Download failed for {url}")
                failed_links.append(url)
        except Exception as e:
            print(f"   [FAIL] Handler error: {e}")
            failed_links.append(url)
        finally:
            await page.close()


def _fetch_head_info(url):
    """Fetch HEAD info for a URL, returning (filesize, filename)."""
    try:
        head_resp = requests.head(url, allow_redirects=True, timeout=10)
        filesize = int(head_resp.headers.get("Content-Length", 0))
        filename = "unknown_file"
        disp = head_resp.headers.get("Content-Disposition", "")
        if "filename=" in disp:
            filename = disp.split("filename=")[-1].strip('"\'')
        elif "filename*" in disp:
            filename = disp.split("''")[-1].strip()
        if filename == "unknown_file":
            filename = url.split("/")[-1]
        return filesize, filename
    except Exception as e:
        print(f"   [WARN] Could not fetch HEAD info: {e}")
        return None, None


async def process_rd_links(rd_links, browser, downloads, failed_links, output_dir,
                             download_dir, current_run_files, args,
                             mega_folder_rd_automation_fn,
                             download_file_with_browser_fn,
                             upload_local_with_fallbacks_fn,
                             get_google_drive_service_fn,
                             upload_to_google_drive_fn,
                             upload_to_katfile_fn, can_upload_to_katfile_fn,
                             katfile_api_key, katfile_upload_dir,
                             script_dir=None):
    """Process Real-Debrid classified links (mega folders + individual files)."""
    mega_folder_links = [u for u in rd_links if '/folder/' in u.lower()]
    mega_file_links = [u for u in rd_links if '/folder/' not in u.lower()]

    folder_unrestricted_urls = []
    if mega_folder_links:
        print(f"\n[MEGA FOLDER PROCESSING] {len(mega_folder_links)} mega folder(s) to process via RD extension...")
        for idx, url in enumerate(mega_folder_links, 1):
            print(f"\n[{idx}/{len(mega_folder_links)}] Processing Mega Folder: {url}")
            page = await browser.new_page()
            try:
                folder_urls = await mega_folder_rd_automation_fn(page, url, browser, idx, output_dir)
                folder_unrestricted_urls.extend(folder_urls)
            except Exception as e:
                print(f"   [FAIL] Mega folder automation error: {e}")
                failed_links.append(url)
            finally:
                await page.close()

        if folder_unrestricted_urls:
            print(f"\n[MEGA FOLDER] Got {len(folder_unrestricted_urls)} unrestricted URLs from folder(s). Processing each...")

    all_rd_urls = mega_file_links + folder_unrestricted_urls
    print(f"\n[BROWSER EXTENSION PROCESSING] Opening {len(all_rd_urls)} links to let Real-Debrid auto-unrestrict...")
    for idx, url in enumerate(all_rd_urls, 1):
        print(f"\n[{idx}/{len(all_rd_urls)}] Processing Link: {url}")

        page = await browser.new_page()

        captured_unrestricted = []
        async def on_req(req):
            if "real-debrid.com/d/" in req.url:
                captured_unrestricted.append(req.url)
        page.on("request", on_req)

        page_loaded = False
        for load_attempt in range(1, 3):
            try:
                await page.goto(url, timeout=15000)
                page_loaded = True
                break
            except Exception as e:
                print(f"   [WARN] Page load attempt {load_attempt}/2 failed: {str(e)[:50]}")
                if load_attempt == 2:
                    print(f"   [WARN] Continuing but page may not have loaded fully.")
                await asyncio.sleep(2)

        is_interactive = __import__('sys').stdin.isatty() and not args.non_interactive

        unrestricted = None

        if "real-debrid.com/d/" in url.lower():
            print(f"   [INFO] Already unrestricted RD URL from folder automation, fetching HEAD info...")
            filesize, filename = _fetch_head_info(url)
            if filesize is not None:
                unrestricted = {
                    "download_url": url,
                    "filename": filename,
                    "filesize": filesize
                }
                print(f"   ✓ RD URL: {filename} ({filesize / (1024**2):.1f} MB)")
        else:
            print(f"   [POLLING] Waiting up to 30 seconds for Real-Debrid extension to capture link...")
            for poll_sec in range(30):
                if captured_unrestricted:
                    break
                await asyncio.sleep(1)

        if captured_unrestricted:
            rd_links_file = os.path.join(output_dir, "rd_unrestricted_links.txt")
            with open(rd_links_file, 'a', encoding='utf-8') as f:
                for rd_url in captured_unrestricted:
                    f.write(rd_url + '\n')
            print(f"   ✓ Extension captured {len(captured_unrestricted)} unrestricted URL(s), saved to {rd_links_file}")

            for rd_url in captured_unrestricted:
                print(f"\n   [RD] Processing: {rd_url}")
                filesize, filename = _fetch_head_info(rd_url)
                if filesize is None:
                    continue

                filesize_mb = filesize / (1024 ** 2)
                filesize_gb = filesize / (1024 ** 3)

                if filesize < 25 * 1024 * 1024:
                    print(f"   [SKIP] File too small ({filesize_mb:.2f} MB < 25 MB), skipping")
                    continue
                if filesize > 2 * 1024 * 1024 * 1024:
                    print(f"   [SKIP] File too large ({filesize_gb:.2f} GB > 2 GB), skipping")
                    continue

                print(f"   [OK] {filename} ({filesize_mb:.1f} MB) — downloading + uploading...")
                uploaded = False

                # 1. Try cloud storage fallbacks
                print(f"   [OK] Trying cloud storage fallbacks ({filesize_gb:.2f}GB)...")
                download_path = await download_file_with_browser_fn(
                    rd_url, filename, browser, idx, download_dir, current_run_files
                )
                if download_path and os.path.exists(download_path):
                    fallback_result = upload_local_with_fallbacks_fn(download_path, idx)
                    if fallback_result and fallback_result.get('url'):
                        downloads.append({
                            'mega_url': url,
                            'filename': filename,
                            'fallback_url': fallback_result['url'],
                            'size': filesize,
                            'type': 'cloud_fallback'
                        })
                        uploaded = True
                    try:
                        os.remove(download_path)
                    except Exception:
                        pass

                # 2. If cloud fallbacks failed, try Google Drive
                if not uploaded:
                    print(f"   [WARN] Cloud fallbacks failed, trying Google Drive...")
                    drive_service = get_google_drive_service_fn(script_dir) if script_dir else get_google_drive_service_fn()
                    if drive_service:
                        download_path = await download_file_with_browser_fn(
                            rd_url, filename, browser, idx, download_dir, current_run_files
                        )
                        if download_path and os.path.exists(download_path):
                            drive_result = upload_to_google_drive_fn(
                                download_path, filename, drive_service, idx
                            )
                            if drive_result:
                                downloads.append({
                                    'mega_url': url,
                                    'filename': filename,
                                    'drive_url': drive_result.get('drive_url'),
                                    'size': filesize,
                                    'type': 'gdrive'
                                })
                                uploaded = True
                            try:
                                os.remove(download_path)
                            except Exception:
                                pass

                # 3. If Google Drive also failed, try Katfile remote stream
                if not uploaded and katfile_api_key and can_upload_to_katfile_fn(filesize):
                    print(f"   [WARN] Trying Katfile remote stream ({filesize_gb:.2f}GB)...")
                    katfile_result = upload_to_katfile_fn(rd_url, filename, idx)
                    if katfile_result:
                        downloads.append({
                            'mega_url': url,
                            'filename': filename,
                            'katfile_url': katfile_result.get('katfile_url'),
                            'size': filesize,
                            'type': 'katfile'
                        })
                        uploaded = True

                # 4. If everything failed, save to local overflow
                if not uploaded:
                    print(f"   [WARN] All uploads failed, saving to {katfile_upload_dir}...")
                    download_path = await download_file_with_browser_fn(
                        rd_url, filename, browser, idx, download_dir, current_run_files
                    )
                    if download_path:
                        import shutil
                        overflow_path = os.path.join(katfile_upload_dir, filename)
                        shutil.move(download_path, overflow_path)
                        downloads.append({
                            'mega_url': url,
                            'filename': filename,
                            'path': overflow_path,
                            'size': filesize,
                            'type': 'local_overflow'
                        })

            await page.close()
            continue

        print(f"   [INFO] No RD link captured. Nothing to process.")
        failed_links.append(url)
        await page.close()
