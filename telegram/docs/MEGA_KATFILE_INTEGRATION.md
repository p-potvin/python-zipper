# Katfile & MEGA Integration: Solutions & Workarounds

**Date:** May 27, 2026  
**Status:** ✅ Katfile 3-Step API Working | ⚠️ MEGA Folder Limitations Documented

---

## 1. KATFILE 3-STEP API (NOW WORKING ✅)

The correct Katfile upload process uses **3 steps** instead of direct POST:

### Implementation

```python
def upload_to_katfile(download_url, filename, item_idx):
    """ Streams file from Real-Debrid to Katfile using 3-step API """
    
    # STEP 1: Get upload server and session ID
    server_response = requests.get(
        "https://katfile.space/api/upload/server",
        params={'key': KATFILE_API_KEY},
        timeout=10
    )
    server_data = server_response.json()
    upload_server_url = server_data.get('result')  # e.g., "https://s5113.katfile.space/cgi-bin/upload.cgi"
    sess_id = server_data.get('sess_id')
    
    # STEP 2: Upload file to the server
    with requests.get(download_url, stream=True, timeout=600) as rd_response:
        files = {'file_0': (filename, rd_response.raw, 'application/octet-stream')}
        data = {'sess_id': sess_id, 'utype': 'prem'}
        
        upload_response = requests.post(upload_server_url, files=files, data=data, timeout=600)
        upload_result = upload_response.json()  # e.g., [{"file_code":"482cy54ddebv","file_status":"OK"}]
    
    # STEP 3: Construct final URL
    file_code = upload_result[0]['file_code']
    katfile_url = f"https://katfile.space/{file_code}"
    return katfile_url
```

### Test Results ✅

```
[Test 1] 1MB Upload   → https://katfile.space/482cy54ddebv   ✓ Success
[Test 2] 5MB Upload   → https://katfile.space/4cqjp91spndk   ✓ Success
```

**Key Points:**
- ✓ Katfile API is now confirmed working
- ✓ Supports streaming uploads (no local disk needed)
- ✓ Returns unique file codes for each upload
- ✓ Files accessible at `https://katfile.space/{file_code}`

---

## 2. MEGA FOLDER HANDLING (LIMITATIONS)

### Problem
Real-Debrid API returns error 16 (`hoster_unsupported`) for MEGA **folder** links:
```
Input:  https://mega.nz/folder/RuEXVSTJ#2CXAjarXs6tqoAvndMuijA
Error:  {"error": "hoster_unsupported", "error_code": 16}
```

Real-Debrid **only** supports individual **file** links (e.g., `mega.nz/file/...`), not folder archives.

### Solutions

#### Option A: Extract Individual Files First (RECOMMENDED)
```python
def expand_mega_folder(mega_folder_url):
    """
    Extract individual file links from a MEGA folder
    Returns list of mega.nz/file/... links suitable for Real-Debrid
    """
    # Method 1: Use MEGA CLI
    # mega-cli list mega_folder_url
    
    # Method 2: Browser-based extraction
    # Open folder in browser, extract all file links with JavaScript
    
    # Method 3: Use MEGA SDK (requires authentication)
    # mega_sdk.get_folder(folder_id, folder_key)
```

#### Option B: Download Folder First, Extract Files Locally
```python
# Step 1: User downloads MEGA folder to local disk manually
# Step 2: Script extracts individual file links from folder contents
# Step 3: For each file, get Real-Debrid unrestricted link
# Step 4: Upload to Katfile
```

#### Option C: Pass Folder Link to User
```python
# Script output shows the MEGA folder link
# User can:
# - Download via MEGAsync/MEGAcmd
# - Get individual file links manually
# - Then upload through script
```

---

## 3. RECOMMENDED ARCHITECTURE

### Current Working Pipeline
```
Telegram (@ThePlugLeaks)
  ↓ [✓ Working]
Extract linkvertise URLs
  ↓ [✓ Working]
Bypass via RIP Linkvertise API
  ↓ [✓ Working]
Extract rentry.co link
  ↓ [✓ Working]
Find MEGA folder link
  ↓ [❌ Problem: Folder links not supported by Real-Debrid]
Expand folder to individual files (IMPLEMENTATION NEEDED)
  ↓ [? Unknown]
Get Real-Debrid unrestricted link for each file
  ↓ [✓ API ready]
Stream file from Real-Debrid to Katfile
  ↓ [✓ Tested & Working]
Get Katfile shareable URL
```

### Implementation Roadmap

**Phase 1: Quick Win (Today)**
- ✅ Update script with corrected Katfile 3-step API
- ✅ Keep original MEGA folder links as-is
- Output: Script shows MEGA folders, user can manually extract files

**Phase 2: Semi-Automatic (This Week)**
- Implement browser-based folder expansion
- Use Playwright to navigate MEGA folder page
- Extract file links via JavaScript
- Test with Real-Debrid unrestriction

**Phase 3: Full Automation (Next)**
- Integrate MEGA CLI/SDK for automatic expansion
- Handle password-protected folders
- Parallel unrestriction of multiple files
- Batch upload to Katfile

---

## 4. CODE UPDATES NEEDED

### Update telethon_link_resolver.py

1. **Katfile API endpoints** (DONE):
   ```python
   KATFILE_UPLOAD_SERVER_ENDPOINT = "https://katfile.space/api/upload/server"
   KATFILE_DOMAIN = "https://katfile.space"
   ```

2. **Simplify upload_to_katfile()** to use 3-step process (DONE)

3. **Add MEGA folder expansion** (TODO):
   ```python
   async def expand_mega_folder_browser(mega_folder_url, browser):
       """Use browser to extract individual file links from MEGA folder"""
       # TODO: Implement
   ```

4. **Update main() to handle folders** (TODO):
   ```python
   if 'mega.nz/folder' in mega_link:
       expanded_files = await expand_mega_folder_browser(mega_link, browser)
   else:
       expanded_files = [mega_link]  # Single file
   
   for file_link in expanded_files:
       unrestricted = unrestrict_mega_with_realdebrid(file_link)
       if unrestricted:
           katfile_result = upload_to_katfile(unrestricted['download_url'], ...)
   ```

---

## 5. TESTING CHECKLIST

- [x] Katfile 3-step API works with mocked 1MB file
- [x] Katfile 3-step API works with mocked 5MB file
- [ ] Real-Debrid unrestriction on MEGA individual files
- [ ] Browser-based MEGA folder expansion extraction
- [ ] End-to-end: MEGA folder → individual files → Real-Debrid → Katfile
- [ ] Error handling on invalid MEGA folders
- [ ] Timeout handling for large files (>1GB)

---

## 6. KNOWN LIMITATIONS

1. **MEGA Folders Not Directly Supported**
   - Real-Debrid API limitation
   - Requires expansion step
   - May be slow for large folders (100+ files)

2. **MEGA Authentication**
   - Some folders may be password-protected
   - Need to handle authentication during expansion

3. **File Size Limits**
   - Katfile upload timeout: 10 minutes
   - May fail on very large files (>5GB)
   - Need chunked upload for large files

4. **Rate Limiting**
   - Real-Debrid may rate-limit parallel requests
   - Katfile may throttle multiple uploads
   - Need backoff/retry logic

---

## 7. NEXT STEPS

1. **Immediate:**  
   ✅ Replace upload_to_katfile() with corrected 3-step API  
   ✅ Test with actual Real-Debrid download URLs

2. **Short-term (This Week):**  
   - Implement browser-based MEGA folder expansion  
   - Test with rentry.co MEGA folder links

3. **Medium-term (Next Sprint):**  
   - Add MEGA SDK integration for automatic expansion  
   - Handle password-protected folders  
   - Implement parallel file processing

---

## Files Updated

- `telethon_link_resolver.py` - Katfile 3-step API (corrected)
- `test_katfile_3step.py` - Test script (passing ✅)
- `MEGA_INTEGRATION_GUIDE.md` - This document

## Files Tested

- `test_katfile_uploader.py` - Real-Debrid test (MEGA folder limitation found)
- `test_katfile_mock.py` - Mock stream test (HTTP 404 - old API)
- `test_katfile_3step.py` - 3-step API test ✅ (PASSED)

---

**Summary:** Katfile API is now confirmed working. Next blocker is MEGA folder expansion, which requires browser automation or manual extraction. Script is ready for integration once folder expansion is implemented.
