# Google Drive Integration with OAuth2

## Status: ✅ Ready to Use

Your OAuth2 credentials are configured and ready!

## Setup Summary

**You have:**

- ✅ OAuth2 client_secret file in `.access/`
- ✅ Google Drive API library installed
- ✅ Pipeline configured to use OAuth2

**What happens on first run:**

1. Pipeline detects OAuth2 credentials
2. Opens browser for Google Sign-in (one-time)
3. Saves token for automatic future runs
4. Uploads files to YOUR Google Drive

## How It Works

### Upload Priority (100MB-3GB files)

```text
Priority 1: Katfile (fast shared links)
├─ If quota available (< 2GB today)
└─ Upload to Katfile

Priority 2: Google Drive (fallback)
├─ If Katfile quota exceeded
└─ Upload to Google Drive (shared link)

Priority 3: Local Storage (final fallback)
├─ If both services fail
└─ Save to G:\KatfileOverflow
```

### Large Files (3GB-10GB)

```text
→ Always download to G:\TelethonDownloads
  (Too large for cloud upload services)
```

## First Run - Authorization

**On first execution**, the pipeline will:

1. Try to open browser for Google Sign-in
2. If browser unavailable (headless), shows manual authorization URL
3. You visit URL on another device with browser access
4. Copy authorization code from redirect URL
5. Paste code when pipeline prompts
6. Save token for future runs
7. Resume pipeline automatically

### Browser Mode (Automatic)

```text
1. Pipeline opens browser window
2. You sign in to Google
3. Browser redirects with code
4. Pipeline captures code automatically
5. No manual steps needed
```

### Headless Mode (When Browser Inaccessible)

```text
When browser unavailable:
1. Pipeline shows authorization URL:
   https://accounts.google.com/o/oauth2/auth?...

2. Copy the URL and visit on another computer

3. After signing in, you get redirected to:
   http://localhost:8000/?code=<AUTH_CODE>&state=...

4. Copy the AUTH_CODE from the URL

5. Paste into pipeline when prompted:
   Enter authorization code: [paste code here]

6. Token saved automatically
```

### Manual Authorization Steps

**If browser won't open:**

1. **Get URL from pipeline output**

   ```text
   Copy this URL and open in browser:
   https://accounts.google.com/o/oauth2/auth?...
   ```

2. **Open URL in browser (any computer)**
   - Can be Windows, Mac, iPhone, etc.
   - Just needs internet access
   - Can be different machine

3. **Sign in to Google**
   - Use your Google account
   - Grant permission to sync files

4. **Copy authorization code**
   - After sign-in, redirected to:

   ```text
   http://localhost:8000/?code=XXXXX&state=YYYYY
   ```

   - Look for `code=` parameter
   - Example: `4/0AY0e...Ck8mEX`

5. **Paste code into pipeline**

   ```text
   Enter authorization code: 4/0AY0e...Ck8mEX
   ```

6. **Pipeline completes**
   - Token saved locally
   - Future runs use cached token
   - No re-authentication needed

## Token Management

Tokens are stored in: `telegram/.gdrive_token.json`

**Automatic behavior:**

- Token automatically refreshes when expired
- No manual intervention needed
- Lasts up to 1 year before expiring

**If token fails:**

- Delete `telegram/.gdrive_token.json`
- Next run will re-authorize automatically

## Upload Features

### Shared Links

Files uploaded to Google Drive automatically get shareable links:

```text
Example: https://drive.google.com/file/d/FILE_ID/view?usp=sharing
```

### Storage Quota

- **Your Account:** Full Google Drive storage (free: 15GB, paid: unlimited)
- **File Access:** Only through shared links, not in Drive root
- **Folders:** Files organized by date in pipeline folder

### File Sharing

Each upload is made "shareable" - anyone with the link can access

## Configuration

### OAuth2 File Location

```text
C:\Users\Administrator\Desktop\Github Repos\.access\
└── client_secret_*.apps.googleusercontent.com.json
```

### Token Cache Location

```text
telegram/
└── .gdrive_token.json (auto-created on first auth)
```

### Upload Log

```text
telegram/output/
└── uploads_log.txt (tracks all files by service)
```

## Log Examples

### Katfile Upload

```text
[2026-05-28 09:15:33] movie.zip (1.2 GB) → KATFILE
  URL: katfile.space/xxxxxxxx
```

### Google Drive Upload (Fallback)

```text
[2026-05-28 15:30:22] archive.zip (1.5 GB) → GDRIVE
  URL: https://drive.google.com/file/d/FILE_ID/view?usp=sharing
```

### Local Overflow

```text
[2026-05-28 23:45:10] backup.zip (2.5 GB) → LOCAL_OVERFLOW
  Path: G:\KatfileOverflow\backup.zip
```

## Troubleshooting

### "OAuth2 auth failed"

**Solution:**

1. Verify client_secret file exists: `.access/client_secret_*.json`
2. Delete token cache: `telegram/.gdrive_token.json`
3. Run pipeline again (will re-authorize)

### "Failed to refresh token"

**Solution:**

1. Token expired (older than 1 year)
2. Delete `telegram/.gdrive_token.json`
3. Next run will re-authorize
4. All future uploads continue working

### "Upload to Google Drive failed"

**Fallback to local storage:**

1. Files saved to `G:\KatfileOverflow` instead
2. Check disk space if many large files
3. Can manually upload from local folder later

### "Browser won't open for authorization"

**Headless environment:**

1. Pipeline outputs authorization URL
2. Visit link on another computer with browser
3. Enter generated code (if prompted)
4. Or copy token JSON if provided

## Google Drive Folder Structure

Pipeline creates organized structure:

```text
Telethon-Pipeline/
├── 2026-05-28/
│   ├── file1.zip
│   ├── file2.zip
│   └── file3.zip
├── 2026-05-29/
│   └── file4.zip
└── ...
```

- *Note: Only visible through shared links, not in main Drive*

## API Quota

Google Drive API has generous limits for personal use:

| Limit | Value |
| ------- | ------- |
| Queries/day | 1,000,000,000 |
| Writes/day | 1,000 |
| Uploads/day | Unlimited |
| Max file size | 5TB |

**For your usage:** Unlimited (well within quota)

## Advanced: Service Account

If you have a service account JSON file:

1. Place in `.access/service-account.json`
2. Pipeline will automatically use it (preferred over OAuth2)
3. No browser authorization needed
4. Better for automation

**To create service account:**

1. Google Cloud Console → Service Accounts
2. Create new service account
3. Create JSON key
4. Download and place in `.access/service-account.json`

## Privacy & Security

**What the pipeline does:**

- ✅ Uploads files to YOUR account only
- ✅ Uses standard Google OAuth2 (secure)
- ✅ Tokens stored locally in `telegram/`
- ✅ No external servers involved
- ✅ No credentials logged or shared

**What it doesn't do:**

- ❌ Share personal info
- ❌ Access other Drive files
- ❌ Modify existing files
- ❌ Share credentials externally

## File Size Handling

| Size | Action | Notes |
| ------ | -------- | ------- |
| < 100 MB | Skip | Too small for processing |
| 100 MB - 3 GB | Katfile → Drive | Shared links |
| 3 GB - 10 GB | Download locally | G:\TelethonDownloads |
| > 10 GB | Skip | Too large |

## Daily Quota

- **Katfile:** 2GB per day (resets at midnight UTC)
- **Google Drive:** Unlimited uploads (5TB max)
- **Local Fallback:** Unlimited (disk space dependent)

## Next Steps

1. **Run the pipeline normally** - OAuth2 will trigger on first file upload
2. **Authorize in browser** when prompted
3. **Token saved** for automatic future runs
4. **Monitor uploads** in `uploads_log.txt`
5. **Check shared links** in Drive for uploaded files

## Support

- **Google Drive API Docs:** <https://developers.google.com/drive/api>
- **OAuth2 Flow:** <https://developers.google.com/identity/oauth2>
- **Troubleshooting:** Check `telegram/artifacts/` for debug logs

---

**Status:** ✅ Production Ready (OAuth2 configured)

**Last Updated:** 2026-05-28

**Authentication:** OAuth2 (installed app flow)

**Token Refresh:** Automatic (caches in `telegram/.gdrive_token.json`)
