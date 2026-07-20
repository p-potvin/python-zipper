#!/usr/bin/env python3
"""
Rentry -> Local or MEGA -> Katfile Pipeline
- For MEGA links: Get size via HEAD request, skip Real-Debrid
- For other links: Upload directly to Katfile, skip Real-Debrid
- Filter: Skip files <100MB, >3GB, and photo files
"""

import asyncio
import re
import os
from patchright.async_api import async_playwright
import aiohttp
import json
from pathlib import Path


# Configuration
REALDEBRID_API_TOKEN_FILE = r"C:\Users\Administrator\Desktop\Github Repos\.access\realdebrid_api.txt"
KATFILE_API_KEY_FILE = r"C:\Users\Administrator\Desktop\Github Repos\.access\katfiles_api.txt"

# Load API keys
KATFILE_API_KEY = None

if os.path.exists(KATFILE_API_KEY_FILE):
    with open(KATFILE_API_KEY_FILE, 'r', encoding='utf-8') as f:
        KATFILE_API_KEY = f.read().strip()
    print(f"[OK] Loaded Katfile API key")

if not KATFILE_API_KEY:
    print("[ERROR] Katfile API key not found!")
    exit(1)

MIN_FILESIZE = 100 * 1024 * 1024  # 100 MB
MAX_FILESIZE = 3 * 1024 * 1024 * 1024  # 3 GB

# Photo file extensions to skip (for speed)
PHOTO_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.ico', '.svg'}

# MEGA hosts
MEGA_HOSTS = ['mega.nz', 'mega.co.nz']


async def extract_links_from_rentry(rentry_url):
    """Extract all links from Rentry page using browser"""
    
    print(f"\n[Rentry] Extracting links from {rentry_url}...")
    
    user_data_dir = r"C:\Users\Administrator\Desktop\Github Repos\python-zipper\.browser_profile"
    async with async_playwright() as p:
        print(f"Launching Patchright to extract links from: {rentry_url}")
        context = await p.chromium.launch_persistent_context(
            channel="chrome",                 # Uses your stable Google Chrome app binary
            headless=False,                  # OPENS THE BROWSER VISUALLY
            no_viewport=True,
            user_data_dir=user_data_dir,
            executable_path=r"C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.exe",
            artifacts_dir=r"G:\artifacts"
        )
        page = await context.new_page()
        
        try:
            await page.goto(rentry_url, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(2)
            
            # Extract all links from the page
            links = await page.evaluate("""
                () => {
                    const links = Array.from(document.querySelectorAll('a'));
                    return links
                        .map(a => a.href)
                        .filter(href => href && (
                            href.startsWith('http://') || 
                            href.startsWith('https://')
                        ))
                        .filter(href => !href.includes('rentry.co'));
                }
            """)
            
            # Get page text content (might have plain URLs)
            text = await page.evaluate("""
                () => document.body.innerText
            """)
            
            # Find plain URLs in text
            url_pattern = r'https?://[^\s<>"{}|\\^`\[\]]*[^\s<>"{}|\\^`\[\],.:;!?)]'
            text_urls = re.findall(url_pattern, text)
            
            all_links = list(set(links + text_urls))
            
            print(f"[Rentry] Found {len(all_links)} total links")
            return all_links
        
        except Exception as e:
            print(f"[Rentry] Error: {str(e)}")
            return []
        
        finally:
            await page.close()
            await browser.close()


def categorize_links(links):
    """Separate MEGA links from other hosts"""
    
    mega_links = []
    other_links = []
    
    for link in links:
        is_mega = any(host in link for host in MEGA_HOSTS)
        if is_mega:
            mega_links.append(link)
        else:
            other_links.append(link)
    
    print(f"\n[Filter] Categorized links:")
    print(f"  MEGA links: {len(mega_links)}")
    print(f"  Other hosts: {len(other_links)}")
    
    return mega_links, other_links


def get_filename_from_url(url):
    """Extract filename from URL"""
    # Try to get from URL path
    match = re.search(r'/([^/?#]+)$', url)
    if match:
        filename = match.group(1)
        # URL decode if needed
        try:
            from urllib.parse import unquote
            filename = unquote(filename)
        except:
            pass
        return filename
    return "file"


def should_skip_file(filename):
    """Check if file should be skipped (photos, size outside limits, etc.)"""
    ext = Path(filename).suffix.lower()
    return ext in PHOTO_EXTENSIONS


async def get_mega_file_size(mega_url, session):
    """Get MEGA file size via HEAD request (no download)"""
    
    try:
        async with session.head(mega_url, allow_redirects=True, timeout=15) as resp:
            if resp.status == 200:
                content_length = resp.headers.get('Content-Length')
                if content_length:
                    return int(content_length)
            return None
    except Exception as e:
        print(f"    [x] Failed to get size: {str(e)}")
        return None


async def process_mega_link(mega_url, session, file_idx):
    """Process a MEGA link: check size, skip if needed"""
    
    print(f"\n[x] Processing MEGA link {file_idx}")
    
    filename = get_filename_from_url(mega_url)
    print(f"    Filename: {filename}")
    
    # Check if it's a photo
    if should_skip_file(filename):
        print(f"    [SKIP] Photo file")
        return None
    
    # Get file size via HEAD request
    filesize = await get_mega_file_size(mega_url, session)
    
    if filesize is None:
        print(f"    [x] Could not determine file size")
        return None
    
    filesize_mb = filesize / (1024 * 1024)
    filesize_gb = filesize / (1024 * 1024 * 1024)
    
    print(f"    Size: {filesize_mb:.1f} MB ({filesize_gb:.2f} GB)")
    
    # Check size limits
    if filesize < MIN_FILESIZE:
        print(f"    [SKIP] Too small (min: 100 MB)")
        return None
    
    if filesize > MAX_FILESIZE:
        print(f"    [SKIP] Too large (max: 3 GB)")
        return None
    
    print(f"    [OK] Size OK, file ready for MEGA download")
    
    return {
        'url': mega_url,
        'filename': filename,
        'filesize': filesize,
        'type': 'mega'
    }


async def upload_to_katfile_from_url(download_url, filename, session, file_idx):
    """Upload file from URL directly to Katfile using 3-step API"""
    
    print(f"    [Katfile] Uploading to Katfile...")
    
    try:
        # Step 1: Get upload server
        server_resp = await session.get(
            f"https://katfile.space/api/upload/server?key={KATFILE_API_KEY}"
        )
        
        if server_resp.status != 200:
            print(f"    [x] Failed to get upload server")
            return None
        
        server_data = await server_resp.json()
        upload_url = server_data.get('result', '')
        sess_id = server_data.get('sess_id', '')
        
        if not upload_url:
            print(f"    [x] No upload URL returned")
            return None
        
        # Step 2: Stream file to upload server
        async with session.get(download_url) as file_resp:
            if file_resp.status == 200:
                content = await file_resp.read()
                
                data = aiohttp.FormData()
                data.add_field('sess_id', sess_id)
                data.add_field('utype', 'prem')
                data.add_field(
                    'file_0',
                    content,
                    filename=filename,
                    content_type='application/octet-stream'
                )
                
                upload_resp = await session.post(upload_url, data=data)
                
                if upload_resp.status == 200:
                    upload_data = await upload_resp.json()
                    
                    if isinstance(upload_data, list) and len(upload_data) > 0:
                        file_code = upload_data[0].get('file_code', '')
                        file_status = upload_data[0].get('file_status', '')
                        
                        if file_status == 'OK' and file_code:
                            katfile_url = f"https://katfile.space/{file_code}"
                            print(f"    [OK] Uploaded to Katfile")
                            print(f"    URL: {katfile_url}")
                            return katfile_url
                        else:
                            print(f"    [x] Upload status not OK: {file_status}")
                            return None
                    else:
                        print(f"    [x] Unexpected response format")
                        return None
                else:
                    print(f"    [x] Upload failed: {upload_resp.status}")
                    return None
            else:
                print(f"    [x] Failed to download: {file_resp.status}")
                return None
        
    except Exception as e:
        print(f"    [x] Exception: {str(e)}")
        return None


async def process_other_link(other_url, session, file_idx):
    """Process non-MEGA link: get size, upload directly to Katfile"""
    
    print(f"\n[*] Processing non-MEGA link {file_idx}")
    
    filename = get_filename_from_url(other_url)
    print(f"    Filename: {filename}")
    
    # Check if it's a photo
    if should_skip_file(filename):
        print(f"    [SKIP] Photo file")
        return None
    
    # Get file size from URL via HEAD request
    try:
        async with session.head(other_url, allow_redirects=True, timeout=15) as resp:
            if resp.status == 200:
                content_length = resp.headers.get('Content-Length')
                if content_length:
                    filesize = int(content_length)
                else:
                    print(f"    [x] Could not determine file size")
                    return None
            else:
                print(f"    [x] URL check failed: {resp.status}")
                return None
    except Exception as e:
        print(f"    [x] Failed to check size: {str(e)}")
        return None
    
    filesize_mb = filesize / (1024 * 1024)
    filesize_gb = filesize / (1024 * 1024 * 1024)
    
    print(f"    Size: {filesize_mb:.1f} MB ({filesize_gb:.2f} GB)")
    
    # Check size limits
    if filesize < MIN_FILESIZE:
        print(f"    [SKIP] Too small (min: 100 MB)")
        return None
    
    if filesize > MAX_FILESIZE:
        print(f"    [SKIP] Too large (max: 3 GB)")
        return None
    
    # Upload directly to Katfile
    katfile_url = await upload_to_katfile_from_url(other_url, filename, session, file_idx)
    
    if katfile_url:
        return {
            'url': other_url,
            'filename': filename,
            'filesize': filesize,
            'katfile_url': katfile_url,
            'type': 'other'
        }
    
    return None


async def main():
    """Main pipeline"""
    
    rentry_url = "https://rentry.co/4x9s8wi9"
    
    print("\n" + "=" * 70)
    print("RENTRY -> LOCAL/MEGA -> KATFILE PIPELINE")
    print("=" * 70)
    
    # Step 1: Extract links from Rentry
    all_links = await extract_links_from_rentry(rentry_url)
    
    if not all_links:
        print("\n[x] No links found on Rentry page")
        return
    
    # Step 2: Categorize links
    mega_links, other_links = categorize_links(all_links)
    
    # Step 3: Process links
    results = []
    
    async with aiohttp.ClientSession() as session:
        # Process MEGA links
        print(f"\n[MEGA Links] Processing {len(mega_links)} MEGA links...")
        mega_idx = 1
        for mega_url in mega_links:
            result = await process_mega_link(mega_url, session, mega_idx)
            if result:
                results.append(result)
            mega_idx += 1
        
        # Process other links
        print(f"\n[Other Links] Processing {len(other_links)} non-MEGA links...")
        other_idx = 1
        for other_url in other_links:
            result = await process_other_link(other_url, session, other_idx)
            if result:
                results.append(result)
            other_idx += 1
    
    # Summary
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)
    
    if results:
        print(f"\n[OK] Processed {len(results)} files:\n")
        for i, result in enumerate(results, 1):
            filesize_mb = result['filesize'] / (1024 * 1024)
            print(f"{i}. {result['filename']}")
            print(f"   Size: {filesize_mb:.1f} MB")
            print(f"   Type: {result['type']}")
            if 'katfile_url' in result:
                print(f"   Katfile: {result['katfile_url']}")
            if result['type'] == 'mega':
                print(f"   Source: {result['url']}")
            print()
    else:
        print("\n[x] No files could be processed")


if __name__ == "__main__":
    asyncio.run(main())
