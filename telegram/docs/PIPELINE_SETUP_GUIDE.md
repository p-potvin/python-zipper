# TELETHON PIPELINE - COMPLETE SETUP GUIDE

==========================================

This integration adds the following features to your Telethon scraper:

1. Windows Notifications - Get alerts when pipeline completes
2. Large File Handling - Files 3GB-10GB download to G:\TelethonDownloads
3. Scheduled Daily Task - Runs at 5:00 AM via Windows Task Scheduler
4. Pagination Support - Processes new messages only, skips already-processed

## FILE STRUCTURE

==============

telegram/
├── telethon_link_resolver.py       (ENHANCED - Windows notifications + large file handling)
├── pipeline_integration.py         (NEW - Rentry hub processing pipeline)
├── setup_scheduled_task.ps1        (NEW - Scheduled task registration script)
├── output/                         (Existing - results directory)
│   ├── resolved_links.txt
│   ├── uploads_log.txt
│   └── pipeline_state.json         (NEW - pagination tracking)
├── artifacts/                      (Existing - debug files)
└── sessions/                       (Existing - Telethon session)

## FILE SIZE CATEGORIES

====================

When files are extracted via Real-Debrid:

1. < 100 MB          → SKIPPED (too small)
2. 100 MB - 3 GB      → UPLOADED to Katfile (shared links)
3. 3 GB - 10 GB       → DOWNLOADED to G:\TelethonDownloads (local storage)
4. > 10 GB            → SKIPPED (too large)

## QUICK START - 4 STEPS

1. Install dependencies: `pip install -r requirements.txt`
2. Configure API keys in `.env` file
3. Run `telethon_link_resolver.py` to test and generate tokens
4. Register scheduled task with `setup_scheduled_task.ps1`

### Step 1: Install required package (if not already done)

pip install win11toast

### Step 2: Verify configuration

Open telethon_link_resolver.py and check:

- REALDEBRID_API_TOKEN_FILE path
- KATFILE_API_KEY_FILE path
- LARGE_FILE_DOWNLOAD_DIR = r"G:\TelethonDownloads"
- All directories exist and are writable

### Step 3: Test the script manually (optional)

cd telegram
python telethon_link_resolver.py

You should see:

- Windows notification on completion (if Real-Debrid processes files)
- Log file updated with upload/download records
- Pipeline state saved for next run

### Step 4: Register the scheduled task

Open PowerShell as Administrator, then:

cd "c:\Users\Administrator\Desktop\Github Repos\python-scripts\telegram"
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope CurrentUser -Force
.\setup_scheduled_task.ps1 -TaskName "Telethon-Pipeline-Daily" -Time "05:00"

You should see:

- Task registered successfully
- Instructions to test immediately or view logs

## WINDOWS NOTIFICATIONS

When the pipeline completes, you'll see a Windows notification showing:

- Number of files uploaded to Katfile
- Number of files downloaded to G:\TelethonDownloads
- Any errors encountered

Example notification:
┌─────────────────────────────────┐
│ Telethon Pipeline Complete      │
│                                 │
│ Uploaded 5 files to Katfile     │
│ Downloaded 2 large files        │
│                                 │
│ [Duration: 10 seconds]          │
└─────────────────────────────────┘

## PAGINATION & STATE TRACKING

The pipeline saves message IDs to track progress:

File: telegram/output/pipeline_state.json
{
  "last_first_message_id": 12345,
  "last_last_message_id": 12350,
  "total_files_uploaded": 47,
  "upload_sessions": [...]
}

On next run:

1. Script checks "last_last_message_id": 12350
2. Processes messages starting from new ones
3. STOPS when it reaches message 12350 (already processed)
4. Updates state with new last_message_id
5. Next 5:00 AM run will start from the newly updated position

This prevents reprocessing the same content!

## SCHEDULED TASK DETAILS

Task Name: Telethon-Pipeline-Daily
Schedule: 5:00 AM daily
Console: conhost.exe (visible in taskbar during execution)
Timeout: 4 hours per run
Retry: Auto-restart up to 2 times on failure (10-minute intervals)

Run levels: Administrator (required for Real-Debrid API calls)

## TESTING & TROUBLESHOOTING

Test the task immediately:
  Start-ScheduledTask -TaskName "Telethon-Pipeline-Daily"

Check task status:
  Get-ScheduledTaskInfo -TaskName "Telethon-Pipeline-Daily"

View task history:
  Get-ScheduledTask -TaskName "Telethon-Pipeline-Daily" | Get-ScheduledTaskInfo

View task definition:
  Get-ScheduledTask -TaskName "Telethon-Pipeline-Daily" | Select-Object *

Update task time (e.g., 3:00 AM instead of 5:00 AM):
  .\setup_scheduled_task.ps1 -TaskName "Telethon-Pipeline-Daily" -Time "03:00"

Unregister task:
  .\setup_scheduled_task.ps1 -TaskName "Telethon-Pipeline-Daily" -Unregister

List all Telethon tasks:
  .\setup_scheduled_task.ps1 -ListTasks

## LOGS & OUTPUT

Main output:
  telegram/output/resolved_links.txt          ← All MEGA links extracted
  telegram/output/linkvertise_links.txt       ← Linkvertise links found
  telegram/output/uploads_log.txt             ← Detailed upload/download log
  telegram/output/pipeline_state.json         ← Pagination state

Debug artifacts:
  telegram/artifacts/                         ← Screenshots & debug files

## REAL-DEBRID CONFIGURATION

If Real-Debrid API is not active:

1. Get API token from: <https://real-debrid.com/account>
2. Save to: C:\Users\Administrator\Desktop\Github Repos\.access\realdebrid_api.txt
3. Restart the script

If using Real-Debrid Browser Extension (recommended):

- Extension auto-unrestricts MEGA folders and alternative hosts
- Works with pipeline_integration.py for advanced workflows
- No additional API key needed (extension handles it)

## LARGE FILE DOWNLOAD DIRECTORY

Files 3GB-10GB are automatically downloaded to:
  G:\TelethonDownloads

Create the directory if it doesn't exist:
  mkdir G:\TelethonDownloads

To change destination, edit telethon_link_resolver.py:
  LARGE_FILE_DOWNLOAD_DIR = r"G:\TelethonDownloads"

## PIPELINE INTEGRATION (ADVANCED)

For processing Rentry hubs with Real-Debrid extension:

from pipeline_integration import PipelineState, process_telegram_messages, MegaContentPipeline

state = PipelineState(OUTPUT_DIR)
await process_telegram_messages(rentry_hub_links, browser, KATFILE_API_KEY, state)

Features:

- Rentry hub extraction
- Linkvertise → RIP bypass chain
- Content filtering (videos only)
- File size exceptions (100MB-10GB range)
- Windows notifications
- Pagination tracking

## API KEYS REQUIRED

For full functionality, you need:

1. Telegram API:
   - API_ID: From <https://my.telegram.org>
   - API_HASH: From <https://my.telegram.org>

2. Real-Debrid API (optional, for MEGA unrestriction):
   - Token: <https://real-debrid.com/account>
   - File: .access/realdebrid_api.txt

3. Katfile API (optional, for file uploads):
   - Key: <https://katfile.space/account>
   - File: .access/katfiles_api.txt

4. RIP Linkvertise API (included):
   - Used for real-time linkvertise bypass
   - No key needed (default key provided)

## WINDOWS NATIVE FEATURES USED

- conhost.exe: Windows Console Host (shows task execution)
- Task Scheduler: Native Windows task automation
- win10toast: Windows 10+ notifications library
- PowerShell: Script execution and task management

## SECURITY NOTES

- All API keys are stored locally in .access/ directory
- Task runs under your current Windows user account
- conhost window appears briefly during execution
- No credentials are transmitted or logged
- Notifications are ephemeral (not stored)

## PERFORMANCE EXPECTATIONS

Typical run time: 10-30 minutes (depending on content)

- Rentry extraction: 1-2 min
- Linkvertise bypass: 3-5 min per link
- Real-Debrid unrestriction: 5-10 min
- File uploads/downloads: 5-15 min
- Cleanup and logging: 1 min

With 4-hour timeout, slow uploads won't cause task failure.

## SUPPORT & ISSUES

If task doesn't run:

1. Check that Windows Task Scheduler service is running
2. Verify PowerShell execution policy: Set-ExecutionPolicy -ExecutionPolicy Bypass
3. Check task history for error codes
4. Run Get-ScheduledTask | Where-Object Name -match "Telethon" to verify registration

If no Windows notification:

1. Check Windows notification settings (Settings > System > Notifications)
2. Verify win10toast installed: pip list | grep win10toast
3. Notification requires display server (no headless servers)

If files not uploading:

1. Verify Katfile API key is valid and current
2. Check file size is between 100MB-3GB
3. Check G:\TelethonDownloads is writable
4. Review uploads_log.txt for error details

If pagination not working:

1. Check pipeline_state.json exists and is readable
2. Verify MESSAGE_SKIP parameter in telethon_link_resolver.py
3. Check message count in channel exceeds MESSAGE_SKIP value

## NEXT STEPS

After setup is complete:

1. At 5:00 AM tomorrow, the task will run automatically
2. You'll see a conhost window briefly in the taskbar
3. On completion, a Windows notification appears
4. Results are logged to telegram/output/uploads_log.txt
5. Pagination is saved for the next run

Optional enhancements:

- Add email notifications (requires SMTP setup)
- Add SMS alerts (requires Twilio/similar service)
- Create GUI dashboard (Tkinter, web-based, etc.)
- Add automatic cleanup of old downloads
- Create backup script for G:\TelethonDownloads

## COMMAND REFERENCE

PowerShell (as Administrator):

### Register new task

.\setup_scheduled_task.ps1

### Register with custom time

.\setup_scheduled_task.ps1 -Time "03:00"

### Unregister task

.\setup_scheduled_task.ps1 -Unregister

### List all Telethon tasks

.\setup_scheduled_task.ps1 -ListTasks

### Test task immediately

Start-ScheduledTask -TaskName "Telethon-Pipeline-Daily"

### View task info

Get-ScheduledTask -TaskName "Telethon-Pipeline-Daily" | FL *

### Disable task temporarily

Disable-ScheduledTask -TaskName "Telethon-Pipeline-Daily"

### Re-enable task

Enable-ScheduledTask -TaskName "Telethon-Pipeline-Daily"

### Manual execution

python telegram\telethon_link_resolver.py

### Test pipeline integration

python telegram\pipeline_integration.py

### Windows Notification Test

To test notifications manually:

python -c "from win11toast import ToastNotifier; ToastNotifier().show_toast('Test', 'Notification works!')"

If this fails:

- Check Windows version is 10 or later
- Verify notification settings allow app notifications
- Check Action Center is functional (Windows key + A)

## END OF GUIDE

For questions or updates, refer to the inline comments in:

- telethon_link_resolver.py (main script)
- pipeline_integration.py (advanced pipeline)
- setup_scheduled_task.ps1 (task registration)
