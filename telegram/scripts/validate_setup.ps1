#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Validate Telethon Pipeline Setup - Check all components are installed and configured
    
.DESCRIPTION
    Verifies:
    - Python environment and dependencies
    - API key files
    - Download directories
    - Task Scheduler (if registered)
    - Windows notification capability
#>

param(
    [switch]$Verbose = $false,
    [switch]$FixPermissions = $false
)

$Green = [System.ConsoleColor]::Green
$Red = [System.ConsoleColor]::Red
$Yellow = [System.ConsoleColor]::Yellow
$Cyan = [System.ConsoleColor]::Cyan

$global:passed = 0
$global:failed = 0
$global:warnings = 0

function Check($name, $condition, $remediation = "") {

    if ($condition) {
        Write-Host "[✓] $name" -ForegroundColor $Green
        $global:passed++
    }
    elseif ($remediation) {
        Write-Host "[ !] $name - $remediation" -ForegroundColor $Yellow
        $global:warnings++
    }
    else {
        Write-Host "[✗] $name" -ForegroundColor $Red
        $global:failed++
    }
}

function Info($msg) {
    Write-Host "[i] $msg" -ForegroundColor $Cyan
}

# Header
Write-Host "`n╔════════════════════════════════════════════════╗" -ForegroundColor $Cyan
Write-Host "║   Telethon Pipeline Setup Validator            ║" -ForegroundColor $Cyan
Write-Host "╚════════════════════════════════════════════════╝`n" -ForegroundColor $Cyan

$scriptDir = "c:\Users\Administrator\Desktop\Github Repos\python-zipper\telegram"
$scriptsDir = Join-Path $scriptDir "scripts"
$outputDir = Join-Path $scriptDir "logs"
$accessDir = "c:\Users\Administrator\Desktop\Github Repos\.access"

# Python Environment
Write-Host "PYTHON ENVIRONMENT" -ForegroundColor $Cyan
Write-Host "─" * 50

$pythonExe = "$scriptDir\..\.venv\Scripts\python.exe"
Check "Virtual environment exists" (Test-Path $pythonExe)

if (Test-Path $pythonExe) {
    Try {
        $pyVersion = & $pythonExe --version 2>&1
        Check "Python executable works" $true
        Info "Python version: $pyVersion"
    }
    Catch {
        Check "Python executable works" $false "Reinstall virtual environment"
    }
    
    # Check required packages
    Try {
        & $pythonExe -c "import telethon; import playwright; import requests" 2>&1 | Out-Null
        Check "Core packages (telethon,playwright,requests)" $true
    }
    Catch {
        Check "Core packages installed" $false "Run: pip install telethon playwright requests"
    }
    
    Try {
        & $pythonExe -c "from win10toast import ToastNotifier" 2>&1 | Out-Null
        Check "win10toast (Windows notifications)" $true
    }
    Catch {
        Check "win10toast installed" $false "Run: pip install win10toast"
    }
    
    Try {
        & $pythonExe -c "import aiohttp" 2>&1 | Out-Null
        Check "aiohttp (async HTTP)" $true
    }
    Catch {
        Check "aiohttp installed" $false "Run: pip install aiohttp"
    }
}

# Script Files
Write-Host "`nSCRIPT FILES" -ForegroundColor $Cyan
Write-Host "─" * 50

Check "telethon_link_resolver.py exists" (Test-Path "$scriptDir\telethon_link_resolver.py")
Check "uploaders.py exists" (Test-Path "$scriptDir\uploaders.py")
Check "pipeline_state.py exists" (Test-Path "$scriptDir\pipeline_state.py")
Check "site_downloaders.py exists" (Test-Path "$scriptDir\site_downloaders.py")
Check "setup_scheduled_task.ps1 exists" (Test-Path "$scriptsDir\setup_scheduled_task.ps1")

# API Keys
Write-Host "`nAPI KEYS & CREDENTIALS" -ForegroundColor $Cyan
Write-Host "─" * 50

if (Test-Path "$accessDir\realdebrid_api.txt") {
    $rd_content = Get-Content "$accessDir\realdebrid_api.txt" -ErrorAction SilentlyContinue
    Check "Real-Debrid API key exists" $true
    if ($Verbose) { Info "Length: $($rd_content.Length) chars" }
}
else {
    Check "Real-Debrid API key" $false "Create: $accessDir\realdebrid_api.txt"
}

if (Test-Path "$accessDir\katfiles_api.txt") {
    $kt_content = Get-Content "$accessDir\katfiles_api.txt" -ErrorAction SilentlyContinue
    Check "Katfile API key exists" $true
    if ($Verbose) { Info "Length: $($kt_content.Length) chars" }
}
else {
    Check "Katfile API key" $false "Create: $accessDir\katfiles_api.txt"
}

# Directories
Write-Host "`nDIRECTORIES and PATHS" -ForegroundColor $Cyan
Write-Host "─" * 50

Check "Output directory exists" (Test-Path $outputDir)
Check "Large file download directory (G:\TelethonDownloads)" (Test-Path "G:\TelethonDownloads") "Create manually or script will auto-create"
Check "Storage space on G:\" (Test-Path "G:\")

if (Test-Path "G:\") {
    Try {
        $disk = Get-Volume -DriveLetter G -ErrorAction Stop
        $freeGb = [math]::Round($disk.SizeRemaining / 1GB, 1)
        Check "At least 50GB free on G:\" ($freeGb -gt 50) "Only $freeGb GB available - free up space"
        if ($Verbose) { Info "G: drive has $freeGb GB available" }
    }
    Catch {
        Info "Could not check G: drive space"
    }
}

# Configuration
Write-Host "`nCONFIGURATION" -ForegroundColor $Cyan
Write-Host "─" * 50

# Check telethon_link_resolver.py config
$tlr_content = Get-Content "$scriptDir\telethon_link_resolver.py" -Raw -ErrorAction SilentlyContinue
$hasLargeFileDir = $tlr_content -match 'LARGE_FILE_DOWNLOAD_DIR'
$hasMaxFilesize = $tlr_content -match 'MAX_FILESIZE_UPLOAD'
$hasNotifications = $tlr_content -match 'send_notification'

Check "telethon_link_resolver.py has Windows notification support" $hasNotifications
Check "telethon_link_resolver.py has large file handling" ($hasLargeFileDir -and $hasMaxFilesize)

# Task Scheduler
Write-Host "`nWINDOWS SCHEDULED TASK" -ForegroundColor $Cyan
Write-Host "─" * 50

Try {
    $task = Get-ScheduledTask -TaskName "Telethon-Pipeline-Daily" -ErrorAction SilentlyContinue
    if ($task) {
        Check "Task Scheduler task registered" $true
        Info "Task Name: $($task.TaskName)"
        Info "States: Enabled=$($task.Settings.Enabled)"
        
        $taskInfo = Get-ScheduledTaskInfo -TaskName "Telethon-Pipeline-Daily" -ErrorAction SilentlyContinue
        if ($taskInfo) {
            Info "Last Run: $($taskInfo.LastRunTime)"
            Info "Last Result: $($taskInfo.LastTaskResult)"
        }
    }
    else {
        Check "Task Scheduler task registered" $false "Run: .\setup_scheduled_task.ps1 (as Administrator)"
    }
}
Catch {
    Check "Task Scheduler task registered" $false "Run: .\setup_scheduled_task.ps1 (as Administrator)"
}

# Windows Version (for notifications)
Write-Host "`nWINDOWS ENVIRONMENT" -ForegroundColor $Cyan
Write-Host "─" * 50

$osVersion = [Environment]::OSVersion.Version
$winVersion = $osVersion.Major
Check "Windows 10 or later (for notifications)" ($winVersion -ge 10)
if ($Verbose) { Info "Windows version: $winVersion.$($osVersion.Minor)" }

Try {
    $conhost = Join-Path $env:windir "System32\conhost.exe"
    Check "conhost.exe available" (Test-Path $conhost)
}
Catch {
    Check "conhost.exe available" $false "Windows system file missing"
}

# State File
Write-Host "`nPIPELINE STATE" -ForegroundColor $Cyan
Write-Host "─" * 50

$stateFile = Join-Path $outputDir "pipeline_state.json"
if (Test-Path $stateFile) {
    Try {
        $state = Get-Content $stateFile | ConvertFrom-Json
        Check "pipeline_state.json valid JSON" $true
        if ($Verbose) {
            Info "Last message IDs: $($state.last_first_message_id) to $($state.last_last_message_id)"
            Info "Total files uploaded: $($state.total_files_uploaded)"
        }
    }
    Catch {
        Check "pipeline_state.json valid JSON" $false "Delete and recreate on first run"
    }
}
else {
    Info "pipeline_state.json will be created on first run"
}

# Summary
Write-Host "`n" + "=" * 50 -ForegroundColor $Cyan
Write-Host "VALIDATION SUMMARY" -ForegroundColor $Cyan
Write-Host "=" * 50

$total = $global:passed + $global:failed + $global:warnings
$percent = if ($total -gt 0) { [math]::Round(($global:passed / $total) * 100, 0) } else { 0 }

Write-Host "✓ Passed:  $global:passed" -ForegroundColor $Green
Write-Host "! Warnings: $global:warnings" -ForegroundColor $Yellow
Write-Host "✗ Failed:  $global:failed" -ForegroundColor $Red
Write-Host "─" * 50
Write-Host "Score: $percent% ($global:passed/$total)"

if ($global:failed -eq 0 -and $global:warnings -eq 0) {
    Write-Host "`n✓ ALL CHECKS PASSED - Ready to run!" -ForegroundColor $Green
    exit 0
}
elseif ($global:failed -eq 0) {
    Write-Host "`n⚠ All critical items pass, but review warnings above" -ForegroundColor $Yellow
    exit 0
}
else {
    Write-Host "✗ FAILED ITEMS NEED ATTENTION - See errors above" -ForegroundColor $Red
    exit 1
}
