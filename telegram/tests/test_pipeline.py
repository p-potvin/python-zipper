#!/usr/bin/env python3
"""
Direct Rentry -> Real-Debrid -> Katfile Pipeline
Skip MEGA links, test with other file hosts (Mega Downloads, GoFiles, etc.)
"""

import asyncio
import re
import os
from playwright.async_api import async_playwright
import aiohttp
import json


# Configuration
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REALDEBRID_API_TOKEN_FILE = r"C:\Users\Administrator\Desktop\Github Repos\.access\realdebrid_api.txt"
KATFILE_API_KEY_FILE = r"C:\Users\Administrator\Desktop\Github Repos\.access\katfiles_api.txt"

# Load API keys
REALDEBRID_API_KEY = None
KATFILE_API_KEY = None

if os.path.exists(REALDEBRID_API_TOKEN_FILE):
    with open(REALDEBRID_API_TOKEN_FILE, 'r', encoding='utf-8') as f:
        REALDEBRID_API_KEY = f.read().strip()
    print(f"[OK] Loaded Real-Debrid API key")

if os.path.exists(KATFILE_API_KEY_FILE):
    with open(KATFILE_API_KEY_FILE, 'r', encoding='utf-8') as f:
        KATFILE_API_KEY = f.read().strip()
    print(f"[OK] Loaded Katfile API key")

if not REALDEBRID_API_KEY:
    print("[ERROR] Real-Debrid API key not found!")
    exit(1)

if not KATFILE_API_KEY:
    print("[ERROR] Katfile API key not found!")
    exit(1)

MIN_FILESIZE = 100 * 1024 * 1024  # 100 MB
MAX_FILESIZE = 3 * 1024 * 1024 * 1024  # 3 GB


async def extract_links_from_rentry(rentry_url):
    """Extract all links from Rentry page using browser"""
    
    print(f"\n[Rentry] Extracting links from {rentry_url}...")
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        try:
            await page.goto(rentry_url, wait_until="domcontentloaded", timeout=10000)
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


async def filter_links(links):
    """Filter out MEGA links, keep only other hosts"""
    
    mega_hosts = ['mega.nz', 'mega.co.nz']
    
    filtered = []
    for link in links:
        is_mega = any(host in link for host in mega_hosts)
        if not is_mega:
            filtered.append(link)
    
    print(f"\n[Filter] Kept {len(filtered)} non-MEGA links:")
    for link in filtered:
        # Extract host
        match = re.search(r'https?://(?:www\.)?([^/]+)', link)
        if match:
            host = match.group(1)
            # Shorten for display
            link_preview = link[:80] + "..." if len(link) > 80 else link
            print(f"  - {host}: {link_preview}")
    
    return filtered


async def unrestrict_with_realdebrid(link, session):
    """Unrestrict link with Real-Debrid API"""
    
    print(f"\n[Real-Debrid] Unrestricting: {link[:70]}...")
    
    try:
        url = "https://api.real-debrid.com/rest/1.0/unrestrict/link"
        
        headers = {
            "Authorization": f"Bearer {REALDEBRID_API_KEY}",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
        
        async with session.post(
            url,
            data={"link": link},
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=30)
        ) as resp:
            response_text = await resp.text()
            
            if resp.status == 200:
                data = await resp.json()
                
                filename = data.get('filename', 'unknown')
                filesize = int(data.get('filesize', 0))
                download_url = data.get('download', '')
                host = data.get('host', 'unknown')
                
                # Check filesize
                if filesize < MIN_FILESIZE:
                    print(f"  x Too small: {filesize / (1024*1024):.1f} MB (min: 100 MB)")
                    return None
                
                if filesize > MAX_FILESIZE:
                    print(f"  x Too large: {filesize / (1024*1024*1024):.1f} GB (max: 3 GB)")
                    return None
                
                print(f"  OK {filename}")
                print(f"    Size: {filesize / (1024*1024):.1f} MB")
                print(f"    Host: {host}")
                
                return {
                    'filename': filename,
                    'filesize': filesize,
                    'download_url': download_url,
                    'host': host
                }
            
            elif resp.status == 401:
                print(f"  x Authentication failed (invalid API key)")
                print(f"     Response: {response_text[:200]}")
                return None
            
            elif resp.status == 403:
                error_data = json.loads(response_text)
                error_msg = error_data.get('error_code') or error_data.get('error', 'unknown')
                error_detail = error_data.get('error', '')
                print(f"  x {error_detail} (code: {error_msg})")
                return None
            
            elif resp.status == 400:
                error_data = json.loads(response_text) if response_text else {}
                error_msg = error_data.get('error_code') or error_data.get('error', 'unknown')
                error_detail = error_data.get('error', 'Bad Request')
                print(f"  x {error_detail}")
                return None
            
            else:
                print(f"  x Error {resp.status}: {response_text[:150]}")
                return None
    
    except asyncio.TimeoutError:
        print(f"  x Request timeout")
        return None
    except Exception as e:
        print(f"  x Exception: {str(e)}")
        return None


async def upload_to_katfile(download_url, filename, session, file_idx):
    """Upload file from Real-Debrid to Katfile using 3-step API"""
    
    print(f"\n[Katfile] Uploading: {filename}")
    
    try:
        # Step 1: Get upload server
        print(f"  [Step 1] Getting upload server...")
        
        server_resp = await session.get(
            f"https://katfile.space/api/upload/server?key={KATFILE_API_KEY}"
        )
        
        if server_resp.status != 200:
            print(f"  x Failed to get upload server")
            return None
        
        server_data = await server_resp.json()
        upload_url = server_data.get('result', '')
        sess_id = server_data.get('sess_id', '')
        
        if not upload_url:
            print(f"  x No upload URL returned")
            return None
        
        print(f"  OK Got upload server")
        
        # Step 2: Stream file to upload server
        print(f"  [Step 2] Streaming file to upload server...")
        
        data = aiohttp.FormData()
        data.add_field('sess_id', sess_id)
        data.add_field('utype', 'prem')
        
        # Download and stream the file
        async with session.get(download_url) as file_resp:
            if file_resp.status == 200:
                content = await file_resp.read()
                data.add_field(
                    f'file_0',
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
                            # Step 3: Construct URL
                            katfile_url = f"https://katfile.space/{file_code}"
                            print(f"  OK Upload successful")
                            print(f"    URL: {katfile_url}")
                            return katfile_url
                        else:
                            print(f"  x Upload status not OK: {file_status}")
                            return None
                    else:
                        print(f"  x Unexpected response format")
                        return None
                else:
                    print(f"  x Upload failed: {upload_resp.status}")
                    return None
            else:
                print(f"  x Failed to download from Real-Debrid: {file_resp.status}")
                return None
        
    except Exception as e:
        print(f"  x Exception: {str(e)}")
        return None


async def main():
    """Main pipeline"""
    
    rentry_url = "https://rentry.co/4x9s8wi9"
    
    print("="*70)
    print("RENTRY -> REAL-DEBRID -> KATFILE PIPELINE")
    print("="*70)
    
    # Verify Real-Debrid API works
    async with aiohttp.ClientSession() as temp_session:
        print("\n[Real-Debrid] Checking API authentication...")
        try:
            async with temp_session.get(
                "https://api.real-debrid.com/rest/1.0/user",
                headers={"Authorization": f"Bearer {REALDEBRID_API_KEY}"}
            ) as resp:
                if resp.status == 200:
                    user_data = await resp.json()
                    print(f"  OK Authenticated as: {user_data.get('username', 'unknown')}")
                    print(f"    Subscription: {user_data.get('subscription', 'none')}")
                else:
                    print(f"  x Authentication failed: {resp.status}")
                    return
        except Exception as e:
            print(f"  x Error: {str(e)}")
            return
    
    # Step 1: Extract links from Rentry
    all_links = await extract_links_from_rentry(rentry_url)
    
    if not all_links:
        print("\nx No links found on Rentry page")
        return
    
    # Step 2: Filter out MEGA links
    non_mega_links = await filter_links(all_links)
    
    if not non_mega_links:
        print("\nx No non-MEGA links found")
        return
    
    # Step 3: Process each link
    async with aiohttp.ClientSession() as session:
        results = []
        
        for idx, link in enumerate(non_mega_links, 1):
            print(f"\n{'-'*70}")
            print(f"Processing link {idx}/{len(non_mega_links)}")
            print(f"{'-'*70}")
            
            # Unrestrict with Real-Debrid
            unrestricted = await unrestrict_with_realdebrid(link, session)
            
            if unrestricted:
                # Upload to Katfile
                katfile_url = await upload_to_katfile(
                    unrestricted['download_url'],
                    unrestricted['filename'],
                    session,
                    idx
                )
                
                if katfile_url:
                    results.append({
                        'original_host': unrestricted['host'],
                        'filename': unrestricted['filename'],
                        'filesize_mb': unrestricted['filesize'] / (1024*1024),
                        'katfile_url': katfile_url
                    })
            
            # Delay between requests
            await asyncio.sleep(1)
    
    # Summary
    print(f"\n{'='*70}")
    print(f"SUMMARY")
    print(f"{'='*70}")
    
    if results:
        print(f"\nOK Successfully processed {len(results)} files:\n")
        for i, result in enumerate(results, 1):
            print(f"[{i}] {result['filename']}")
            print(f"    Size: {result['filesize_mb']:.1f} MB")
            print(f"    From: {result['original_host']}")
            print(f"    Katfile: {result['katfile_url']}\n")
    else:
        print(f"\nx No files could be processed")


if __name__ == '__main__':
    asyncio.run(main())
