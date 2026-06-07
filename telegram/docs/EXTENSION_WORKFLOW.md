# Real-Debrid Extension Browser Workflow

## Overview

Since MEGA links in rentry pages are detected by the Real-Debrid **browser extension** (not the API), we need to:

1. Open rentry links in a **visible browser** with the extension
2. Let the extension detect and process MEGA links
3. Capture unrestricted links from the browser
4. Download and upload files to Google Drive/Katfile

## Prerequisites

1. **Real-Debrid Browser Extension** must be installed
   - Available for Chrome/Edge: <https://chrome.google.com/webstore>
   - Search for "Real-Debrid"

2. **Real-Debrid Account** must be logged in
   - Extension can handle login prompts automatically

3. **Python Environment** must be set up

   ```powershell
   cd C:\Users\Administrator\Desktop\Github Repos\python-scripts
   .\.venv\Scripts\Activate.ps1
   ```

## Workflow

### Step 1: Process Rentry Links with Browser Extension

```powershell
python telegram/process_with_extension.py
```

**What happens:**

- Browser opens in **VISIBLE** mode (you can see it)
- First rentry link loads
- Real-Debrid extension auto-detects MEGA link
- You see prompt: `"Press ENTER when ready to continue..."`
- Extension processes the link (may take 5-10 seconds)
- Press ENTER when done
- Repeat for next 2 rentry links

**Output:**

- Creates `telegram/output/unrestricted_mega_links.txt`
- Contains unrestricted download URLs

### Step 2: Process Unrestricted Links (Download & Upload)

```powershell
python telegram/process_unrestricted_links.py
```

**What happens:**

- Browser opens in **HEADLESS** mode (automated)
- For each unrestricted link:
  1. Downloads file (generates fitting name + extension)
  2. Tries Katfile upload first
  3. Falls back to Google Drive if Katfile fails
  4. Keeps large files (3-10GB) in local storage
- Logs all results to `uploads_log.txt`

**Output:**

- Files uploaded to Google Drive with proper names
- Katfile links if applicable
- Local files saved in `G:\mega\`

## Tips

### Real-Debrid Extension Not Working?

1. Check that extension is **installed and enabled**
2. Check that you're **logged in** to Real-Debrid
3. Look for **notification icons** in extension
4. Try clicking on MEGA link if auto-detection fails

### How to Read the Browser Console During Step 1

- Right-click → Inspect → Console tab
- Watch for Real-Debrid API responses
- Look for unrestricted download URLs (usually starting with `real-debrid.com/d/`)

### Manual Link Capture

If the script doesn't capture links correctly:

1. During Step 1, copy the unrestricted URL from browser
2. Add to `telegram/output/unrestricted_mega_links.txt` manually
3. Run Step 2

### Troubleshooting

- **Problem: Browser closes too fast**

- Solution: Add `time.sleep(10)` before await browser.close() to give time to see results

- **Problem: Links not captured**

- Solution: Extension may display links differently, check browser console
- Copy URLs manually into unrestricted_mega_links.txt

- **Problem: Google Drive no filename**

- Now fixed! Generates fitting names like `content_20260528_abc123.mp4`

## Files Reference

| File | Purpose |
| ------ | --------- |
| `process_with_extension.py` | Opens rentry links in visible browser with extension |
| `process_unrestricted_links.py` | Downloads from unrestricted URLs and uploads |
| `unrestricted_mega_links.txt` | Intermediate file with download URLs |
| `uploads_log.txt` | Final log with shared links |

## Next Steps After Upload

1. Check `uploads_log.txt` for output URLs
2. Share Google Drive/Katfile links as needed
3. Large files in `G:\mega\` can be uploaded separately
