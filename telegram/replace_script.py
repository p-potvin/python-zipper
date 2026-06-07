import codecs
import re

with open("telethon_link_resolver.py", "r", encoding="utf-8") as f:
    content = f.read()

# We need to find the block of code inside async with async_playwright() as p:
# and replace it with our new logic.

search_str = '''    async with async_playwright() as p:
        # Use bundled Chromium (most reliable)
        print(f"[INFO] Launching bundled Chromium (positioned off-screen)...")
        browser = await p.chromium.launch(
            headless=False,
            args=['--window-size=1280,720', '--window-position=-5000,-5000']
        )'''

replace_str = '''    async with async_playwright() as p:
        # Use Persistent Context to allow Real-Debrid extension to work
        print(f"[INFO] Launching Chrome Persistent Context (for Real-Debrid Extension)...")
        user_data_dir = r"C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\User Data"
        browser = await p.chromium.launch_persistent_context(
            user_data_dir,
            executable_path=r"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            headless=False,
            args=['--disable-blink-features=AutomationControlled']
        )'''

content = content.replace(search_str, replace_str)

search_str2 = '''        # Extract mega links from rentry pages
        print(f"\\n[EXTRACTION] Opening {len(rentry_links)} rentry links to find mega URLs...")
        for idx, (linkvertise, rentry) in enumerate(rentry_links.items(), 1):
            print(f"[{idx}/{len(rentry_links)}] Processing: {rentry}")
            mega_link = await extract_mega_from_rentry(rentry, browser, idx)
            
            if mega_link and 'mega.nz' in mega_link:
                print(f"   ✓ Found mega URL: {mega_link}")
                resolved.add(mega_link)'''

replace_str2 = '''        # Extract all URLs from rentry pages
        print(f"\\n[EXTRACTION] Opening {len(rentry_links)} rentry pages to extract ALL links...")
        
        all_extracted_urls = set()
        for idx, (linkvertise, rentry) in enumerate(rentry_links.items(), 1):
            print(f"[{idx}/{len(rentry_links)}] Extracting links from: {rentry}")
            # Get all URLs, not just mega
            extracted_links = await extract_links_from_rentry(rentry, browser, idx)
            for l in extracted_links:
                all_extracted_urls.add(l)
                resolved.add(l)
                
        # Save all extracted links to file
        all_links_file = os.path.join(OUTPUT_DIR, "all_extracted_links.txt")
        with open(all_links_file, "w", encoding="utf-8") as f:
            for l in sorted(all_extracted_urls):
                f.write(l + "\\n")
        print(f"\\n[INFO] Saved {len(all_extracted_urls)} total extracted links to {all_links_file}")
        
        # Now process all found URLs with the Real-Debrid Browser Extension
        print(f"\\n[BROWSER EXTENSION PROCESSING] Opening links to let Real-Debrid auto-unrestrict...")
        for idx, url in enumerate(sorted(all_extracted_urls), 1):
            print(f"\\n[{idx}/{len(all_extracted_urls)}] Processing Link: {url}")
            
            # Navigate to the link
            page = await browser.new_page()
            
            captured_unrestricted = []
            # Listen to network requests for the unrestricted download URL
            async def on_req(req):
                if "real-debrid.com/d/" in req.url:
                    captured_unrestricted.append(req.url)
            page.on("request", on_req)
            
            try:
                await page.goto(url, timeout=15000)
            except Exception as e:
                print(f"   [WARN] Navigation timeout/error (often fine if extension redirects): {str(e)[:50]}")
            
            print(f"   [INTERACTIVE] Please check the browser.")
            print(f"   If Real-Debrid extension hasn't captured it yet, wait or do it manually.")
            import asyncio
            await asyncio.to_thread(input, "   >>> Press ENTER when the extension is done (or download has started) >>> ")
            
            unrestricted = None
            if captured_unrestricted:
                rd_url = captured_unrestricted[-1]
                print(f"   ✓ Extension captured unrestricted URL: {rd_url}")
                # Get file size and name with HEAD request
                import requests
                try:
                    head_resp = requests.head(rd_url, allow_redirects=True, timeout=10)
                    filesize = int(head_resp.headers.get("Content-Length", 0))
                    
                    filename = "unknown_file"
                    disp = head_resp.headers.get("Content-Disposition", "")
                    if "filename=" in disp:
                        filename = disp.split("filename=")[-1].strip('"\\'')
                    elif "filename*" in disp:
                        filename = disp.split("''")[-1].strip()
                    
                    if filename == "unknown_file":
                        filename = rd_url.split("/")[-1]
                        
                    unrestricted = {
                        "download_url": rd_url,
                        "filename": filename,
                        "filesize": filesize
                    }
                except Exception as e:
                    print(f"   [WARN] Could not fetch HEAD info: {e}")
            
            if unrestricted:
                mega_link = url # Just to keep variable names compatible with the downstream logic'''

content = content.replace(search_str2, replace_str2)

# Also replace the unconditional API call
search_str3 = '''                # Try to unrestrict and upload to Katfile with Real-Debrid
                if REALDEBRID_API_TOKEN:
                    print(f"\\n[{idx}] REAL-DEBRID + FILTERING PHASE:")
                    unrestricted = unrestrict_mega_with_realdebrid(mega_link, idx)'''

replace_str3 = '''                # Downstream upload/download logic
                if True:
                    print(f"\\n[{idx}] DOWNLOADING + FILTERING PHASE:")'''

content = content.replace(search_str3, replace_str3)

# And fix indentation of the lse: print(f"   ✗ Failed to extract mega link")
search_str4 = '''            else:
                print(f"   ✗ Failed to extract mega link")
        
        await browser.close()'''

replace_str4 = '''            else:
                print(f"   [INFO] No RD link captured. If download started manually, check your default downloads folder.")
            await page.close()
        
        await browser.close()'''

content = content.replace(search_str4, replace_str4)

with open("telethon_link_resolver.py", "w", encoding="utf-8") as f:
    f.write(content)
print("Replaced content successfully.")
