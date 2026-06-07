# Fix: "Missing required parameter: redirect_uri"

## Problem

You're getting this error:
```
Missing required parameter: redirect_uri
Error 400: invalid_request
```

## Root Cause

Your Google Cloud OAuth2 credentials were created with a specific `redirect_uri` configured, but the pipeline was trying to use a different one.

Google OAuth2 configuration must exactly match:
- ✅ `http://localhost:8080/` (if configured in Google Cloud)
- ✅ `http://0.0.0.0:8080/` (if configured in Google Cloud)
- ❌ `http://localhost:12345/` (if Google Cloud has 8080 configured)

The random port selection (`port=0`) was causing mismatches.

## Solution

Updated pipeline now tries multiple redirect URIs in order:

1. **Port 8080** (standard for local apps)
   ```
   http://localhost:8080/
   ```

2. **Any available port** (fallback)
   ```
   http://localhost:XXXX/
   ```

3. **Manual code entry** (headless, no server needed)
   - No redirect_uri required
   - You manually copy/paste authorization code

## How to Fix Your Setup

### Option A: Reconfigure Google Cloud (Recommended)

1. Go to: https://console.cloud.google.com/
2. Select your project
3. Go to: APIs & Services → Credentials
4. Click your OAuth2 credential
5. Under "Authorized redirect URIs", add:
   ```
   http://localhost:8080/
   http://localhost/
   http://127.0.0.1:8080/
   ```
6. Click Save

### Option B: Just Run Again (Easier)

Pipeline now tries multiple ports automatically:
1. Run the pipeline again
2. It will try port 8080 first
3. Falls back to other options
4. Manual code entry if needed

## What Happens Now

**First run (with updated code):**
```
[1] Try http://localhost:8080/ 
    └─ If configured in Google Cloud → SUCCESS

[2] Try http://localhost:RANDOM/
    └─ If Google Cloud allows any port → SUCCESS

[3] Use manual code entry
    └─ Copy URL → Browser → Copy code → Paste
```

**Most likely:** Works automatically on Step 1

## Testing

Run this to verify OAuth2 is ready:

```powershell
cd C:\Users\Administrator\Desktop\Github Repos\python-scripts
.\.venv\Scripts\python.exe telegram\test_headless_oauth.py
```

If you still get the redirect_uri error, you need to update Google Cloud (Option A above).

## After Fixing

```powershell
cd C:\Users\Administrator\Desktop\Github Repos\python-scripts
.\.venv\Scripts\python.exe telegram\telethon_link_resolver.py
```

Pipeline will:
1. Try to authenticate with updated redirect_uri logic
2. Get authorization (browser or manual)
3. Save token
4. Resume pipeline

## Reference

**Google OAuth2 Redirect URI Docs:**
https://developers.google.com/identity/protocols/oauth2/native-app

**Common Redirect URIs for Desktop Apps:**
- `http://localhost:8080/` (standard)
- `http://127.0.0.1:8080/`
- `urn:ietf:wg:oauth:2.0:oob` (out-of-band, code entry)

---

**Updated:** 2026-05-28

**Fixed in:** `telethon_link_resolver.py`

**Test Script:** `test_headless_oauth.py`
