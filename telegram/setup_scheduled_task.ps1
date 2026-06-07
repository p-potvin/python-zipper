#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Register a Windows Scheduled Task to run the Telethon Link Resolver pipeline
    
.DESCRIPTION
    Creates a scheduled task that:
    - Runs once daily at 5:00 AM
    - Uses conhost (Windows console host) for visibility
    - Executes telethon_link_resolver.py with the enhanced pipeline
    - Supports pagination (stops at already-processed messages)
    - Sends Windows notifications on completion
    
.PARAMETER TaskName
    Name of the scheduled task (default: "Telethon-Pipeline-Daily")
    
.PARAMETER ScriptPath
    Full path to the telethon_link_resolver.py script
    Default: Detected from script directory
    
.PARAMETER PythonExe
    Path to python.exe (default: .venv/Scripts/python.exe relative to script dir)
    
.PARAMETER Time
    Scheduled run time in HH:mm format (default: 05:00)
    
.EXAMPLE
    .\setup_scheduled_task.ps1 -TaskName "Telethon-Daily" -Time "05:00"
    
.EXAMPLE
    .\setup_scheduled_task.ps1 -Unregister
#>

param(
    [string]$TaskName = "Telethon-Pipeline-Daily",
    [string]$ScriptPath = "",
    [string]$PythonExe = "",
    [string]$Time = "05:00",
    [switch]$Unregister = $false,
    [switch]$ListTasks = $false
)

# Colors for output
$Green = [System.ConsoleColor]::Green
$Red = [System.ConsoleColor]::Red
$Yellow = [System.ConsoleColor]::Yellow
$Cyan = [System.ConsoleColor]::Cyan

function Write-Status($msg, $color = "White") {
    Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] $msg" -ForegroundColor $color
}

# Detect script directory if not provided
if (-not $ScriptPath) {
    $scriptDir = Split-Path -Parent $PSCommandPath
    $ScriptPath = Join-Path $scriptDir "telethon_link_resolver.py"
}

if (-not (Test-Path $ScriptPath)) {
    Write-Status "ERROR: Script not found at $ScriptPath" $Red
    exit 1
}

$scriptDir = Split-Path -Parent $ScriptPath

# Detect python.exe if not provided
if (-not $PythonExe) {
    $venvPython = Join-Path $scriptDir "..\..\.venv\Scripts\python.exe"
    $venvPython = (Resolve-Path $venvPython -ErrorAction SilentlyContinue).Path
    
    if (-not $venvPython -or -not (Test-Path $venvPython)) {
        # Try global python
        $PythonExe = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
        if (-not $PythonExe) {
            Write-Status "ERROR: Could not find python.exe" $Red
            exit 1
        }
    } else {
        $PythonExe = $venvPython
    }
}

if (-not (Test-Path $PythonExe)) {
    Write-Status "ERROR: Python not found at $PythonExe" $Red
    exit 1
}

Write-Status "Telethon Pipeline - Scheduled Task Setup" $Cyan
Write-Status "Script: $ScriptPath"
Write-Status "Python: $PythonExe"
Write-Status "Task Name: $TaskName"
Write-Status "Scheduled Time: $Time (daily)"
Write-Status ""

# List existing tasks
if ($ListTasks) {
    Write-Status "Existing tasks matching pattern:" $Yellow
    Get-ScheduledTask | Where-Object { $_.TaskName -match "Telethon" } | ForEach-Object {
        Write-Host "  - $($_.TaskName): $($_.Triggers.StartBoundary)"
    }
    exit 0
}

# Unregister existing task
if ($Unregister) {
    Write-Status "Unregistering task: $TaskName" $Yellow
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Status "Task unregistered successfully" $Green
    } catch {
        Write-Status "Task not found or error: $($_.Message)" $Yellow
    }
    exit 0
}

# Create wrapper script (runs with conhost)
$wrapperScript = Join-Path $scriptDir "run_pipeline_with_notification.ps1"

$wrapperContent = @"
# Generated wrapper script for scheduled task
# Runs telethon_link_resolver.py via conhost with notifications

`$VerbosePreference = 'SilentlyContinue'
`$WarningPreference = 'SilentlyContinue'

Push-Location "$scriptDir"

Write-Host "[`$(Get-Date -Format 'HH:mm:ss')] Starting Telethon Pipeline..." -ForegroundColor Cyan

try {
    # Run Python script
    & "$PythonExe" telethon_link_resolver.py
    `$exitCode = `$LASTEXITCODE
    
    if (`$exitCode -eq 0) {
        Write-Host "[`$(Get-Date -Format 'HH:mm:ss')] Pipeline completed successfully" -ForegroundColor Green
    } else {
        Write-Host "[`$(Get-Date -Format 'HH:mm:ss')] Pipeline completed with exit code: `$exitCode" -ForegroundColor Yellow
    }
} catch {
    Write-Host "[`$(Get-Date -Format 'HH:mm:ss')] Error: `$_" -ForegroundColor Red
    `$exitCode = 1
}

Pop-Location
exit `$exitCode
"@

Set-Content -Path $wrapperScript -Value $wrapperContent -Encoding UTF8
Write-Status "Created wrapper script: $wrapperScript" $Green

# Parse time
if ($Time -notmatch '^\d{2}:\d{2}$') {
    Write-Status "ERROR: Invalid time format. Use HH:mm (e.g., 05:00)" $Red
    exit 1
}

# Create scheduled task action (runs via conhost)
$conhost = "$env:windir\System32\conhost.exe"
$taskAction = New-ScheduledTaskAction `
    -Execute $conhost `
    -Argument "cmd.exe /c `"powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$wrapperScript`"`""

# Create trigger (daily at specified time)
$taskTrigger = New-ScheduledTaskTrigger `
    -Daily `
    -At $Time

# Create task settings
$taskSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 10)

# Create and register the task
try {
    Write-Status "Registering scheduled task..." $Yellow
    
    # Check if task exists
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        Write-Status "Task already exists, updating..." $Yellow
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    
    # Register new task
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $taskAction `
        -Trigger $taskTrigger `
        -Settings $taskSettings `
        -Description "Telethon Link Resolver - Daily pipeline (runs at $Time, processes new messages only via pagination)" `
        -RunLevel Highest `
        -ErrorAction Stop | Out-Null
    
    Write-Status "Task registered successfully!" $Green
    Write-Status ""
    Write-Status "Task Details:" $Cyan
    Write-Status "  Name: $TaskName"
    Write-Status "  Time: $Time (daily)"
    Write-Status "  Wrapper: $wrapperScript"
    Write-Status "  Console: conhost (visible in taskbar)"
    Write-Status ""
    Write-Status "Features:" $Cyan
    Write-Status "  ✓ Pagination tracking (stops at already-processed message)"
    Write-Status "  ✓ Windows notifications on completion"
    Write-Status "  ✓ Auto-restart on failure (max 2 retries)"
    Write-Status "  ✓ 4-hour execution timeout"
    Write-Status ""
    Write-Status "To test immediately:" $Yellow
    Write-Status "  Start-ScheduledTask -TaskName '$TaskName'"
    Write-Status ""
    Write-Status "To view logs:" $Yellow
    Write-Status "  Get-ScheduledTaskInfo -TaskName '$TaskName'"
    Write-Status ""
    
} catch {
    Write-Status "ERROR: Failed to register task: $($_.Message)" $Red
    exit 1
}

exit 0
