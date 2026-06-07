# Katfile Daily Limit & Fallback Storage

## Overview

The Telethon pipeline supports **automatic fallback to local storage** when:

1. **Katfile's 2GB daily upload limit** is reached
2. Katfile API key is unavailable
3. Katfile upload fails

## Features

✅ **Katfile Primary Storage** (100MB-3GB files)

- First choice for shared download links
- Fast distributed service
- **Daily upload limit: 2GB** (quota resets at midnight)

✅ **Local Fallback Storage** (G:\KatfileOverflow)

- Automatic when Katfile quota exceeded
- Unlimited capacity (limited by disk space)
- Perfect for manual access and backup

✅ **Large File Downloads** (3GB-10GB)

- Download directly to G:\TelethonDownloads
- No upload (files too large for Katfile)

✅ **Rentry Link Resolution**

- Extracts ALL links from Rentry pages (MEGA, Drive, Dropbox, etc.)
- Not limited to single file host per page

## Upload Decision Flow

```
File Size < 100 MB  → SKIP


File Size 100 MB - 3 GB
├─ If Katfile quota available  → Upload to Katfile
│  (Share link generated, fast distribute)
└─ If Katfile quota exceeded   → Save to G:\KatfileOverflow
   (Keep for local/manual access)


File Size 3 GB - 10 GB
└─ Download to G:\TelethonDownloads


File Size > 10 GB  → SKIP
```

## Setup - No Configuration Needed

The pipeline works out of the box! Just run it:

1. **Automatic directory creation** on first run:
   - `G:\KatfileOverflow` (Katfile quota overflow)
   - `G:\TelethonDownloads` (Large file downloads)
   - `telegram/output/` (Local cache)

2. **Only requirements:**
   - Real-Debrid API key: `.access/realdebrid_api.txt` (for MEGA unrestriction)
   - Katfile API key: `.access/katfiles_api.txt` (optional, but recommended)

## File Size Boundaries

| Size | Action | Destination |
|------|--------|-------------|
| < 100 MB | Skip | — |
| 100 MB - 3 GB | Upload/Save | Katfile or G:\KatfileOverflow |
| 3 GB - 10 GB | Download | G:\TelethonDownloads |
| > 10 GB | Skip | — |

## Daily Quota System

The **2GB daily Katfile quota resets at midnight (UTC)**:

```
Day 1:
[09:00] Upload file1.zip (1.0 GB)  ✓ Katfile
[15:00] Upload file2.zip (0.8 GB)  ✓ Katfile
[20:00] Total: 1.8 GB < 2.0 GB     → Available quota: 0.2 GB

[23:00] Upload file3.zip (1.5 GB)  ✗ Exceeds remaining (0.2 GB)
        → Auto-save to G:\KatfileOverflow instead

Day 2 (Midnight UTC Rollover):
[00:01] Quota resets to 2.0 GB     ✓ Fresh allocation
[09:00] Upload file4.zip (1.0 GB)  ✓ Katfile (new quota)
```

## Logging

Pipeline logs all uploads to `uploads_log.txt`:

```
[2026-05-28 09:15:33] file1.zip (1.00 GB) → KATFILE
[2026-05-28 15:30:22] file2.zip (0.80 GB) → KATFILE
[2026-05-28 23:45:10] file3.zip (1.50 GB) → LOCAL_OVERFLOW (quota exceeded)
[2026-05-29 08:10:15] file4.zip (0.50 GB) → KATFILE (quota reset)

Daily Summary:
  2026-05-28: Katfile 1.80 GB, Local Overflow 1.50 GB
  2026-05-29: Katfile 0.50 GB (quota: 1.50 GB remaining)
```

### File Entries

Each entry shows:

- **Timestamp** - When processed
- **Filename** - Original file name
- **Size** - File size in GB
- **Type** - Where saved:
  - `KATFILE` - Uploaded to Katfile
  - `LOCAL_OVERFLOW` - Saved to G:\KatfileOverflow
  - `DOWNLOAD` - Downloaded to G:\TelethonDownloads
  - `SKIP` - File too small/large

## Local Storage Management

### Check Disk Usage

```powershell
# Size of Katfile overflow folder
(Get-ChildItem -Path "G:\KatfileOverflow" -Recurse | 
  Measure-Object -Property Length -Sum).Sum / 1GB

# Size of downloads folder
(Get-ChildItem -Path "G:\TelethonDownloads" -Recurse | 
  Measure-Object -Property Length -Sum).Sum / 1GB
```

### Manual Archive (If Needed)

```powershell
# Move old files to external drive
Move-Item -Path "G:\KatfileOverflow\*" -Destination "E:\Archive\" -Force

# Or zip for backup
Compress-Archive -Path "G:\KatfileOverflow" -DestinationPath "backup_$(Get-Date -Format yyyyMMdd).zip"
```

## Troubleshooting

### "Created G:\KatfileOverflow - Quota Fallback Active"

**Status:** ✅ Normal operation

- Katfile daily quota (2GB) has been exceeded
- Subsequent files automatically save locally
- Quota resets tomorrow at midnight (UTC)

### "Permission denied writing to G:\KatfileOverflow"

**Solution:**

1. Ensure G: drive is accessible
2. Run PowerShell as Administrator
3. Check disk has free space
4. Verify NTFS permissions on folder

### "Filesize > 10 GB - Skipping"

**Status:** ✅ Intentional

- Files over 10 GB skipped (too large for pipelines)
- Can modify `MAX_FILESIZE_DOWNLOAD` in script if needed

### "Katfile upload failed - saving locally instead"

**Status:** ✅ Handled automatically

- Network/API issue with Katfile
- File auto-saved to G:\KatfileOverflow
- No files lost, just different location

## Rentry Link Extraction

Pipeline extracts **ALL links** from Rentry pages:

### Supported Hosts

- **mega.nz** - MEGA cloud storage
- **drive.google.com** - Google Drive
- **dropbox.com** - Dropbox
- **mediafire.com** - MediaFire
- **1fichier.com** - 1Fichier
- **Any HTTP/HTTPS URL** - Generic links

### How It Works

1. Opens each Rentry page in browser
2. Extracts all `<a href>` links
3. Searches text for URL patterns
4. Deduplicates and processes all URLs
5. All extracted links unified in pipeline

**Before:** One link per Rentry page ❌  
**After:** Multiple links per Rentry page ✅

## Configuration Reference

### Key Variables

```python
MIN_FILESIZE = 100 * 1024 * 1024           # 100 MB minimum
MAX_FILESIZE_UPLOAD = 3 * 1024**3          # 3 GB Katfile limit
MAX_FILESIZE_DOWNLOAD = 10 * 1024**3       # 10 GB download limit
KATFILE_DAILY_LIMIT = 2 * 1024**3          # 2 GB daily quota
```

### API Keys Required

```
Real-Debrid:    .access/realdebrid_api.txt    [REQUIRED]
Katfile:        .access/katfiles_api.txt      [OPTIONAL*]

*Katfile recommended for link sharing, but local fallback works without it
```

### Directories

```
Katfile Overflow:  G:\KatfileOverflow
Large Downloads:   G:\TelethonDownloads
Local Cache:       telegram/output/
Error Logs:        telegram/artifacts/
```

## Notifications

On pipeline completion, Windows notification shows summary:

```
✓ Telethon Pipeline Complete

Processed: 18 files total
  • Katfile:      5 files (2.00 GB)
  • Local Storage: 2 files (1.50 GB)
  • Downloads:    1 file (8.00 GB)
  • Skipped:     10 files

Latest Rentry: https://rentry.co/7ganta5f
Next run: Tomorrow 5:00 AM
```

## Future Enhancements

Possible additions if needed:

1. **Cloud Backup**
   - Auto-upload local overflow to cloud
   - Requires OAuth 2.0 (Google Drive, OneDrive, etc.)

2. **Smart Cleanup**
   - Auto-remove files older than N days
   - Compress infrequently accessed files

3. **Compression**
   - Auto-compress to save space before local fallback
   - Extract on demand

4. **Parallel Uploads**
   - Currently: Sequential (1 file at a time)
   - Future: 2-3 concurrent uploads

## Status

- **Pipeline Version:** v2.1 (Katfile Quota + Local Fallback)
- **Last Updated:** 2026-05-28
- **Status:** ✅ Production Ready
- **Tested:** Daily runs, quota rollover, fallback mechanisms

## Next Steps

1. Run pipeline normally - no setup required!
2. Monitor `uploads_log.txt` for quota breakdown
3. Files automatically overflow to `G:\KatfileOverflow` when needed
4. Check disk space monthly on G: drive
5. Enjoy automatic file handling!

---

Questions? Check the logs:

- `uploads_log.txt` - Detailed upload history
- `telegram/artifacts/` - Debug screenshots
- Windows Event Viewer - Scheduled task logs
