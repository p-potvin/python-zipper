# Generated wrapper script for scheduled task
# Runs telethon_link_resolver.py via conhost with notifications

$VerbosePreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

Push-Location "C:\Users\Administrator\Desktop\Github Repos\python-scripts\telegram"

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting Telethon Pipeline..." -ForegroundColor Cyan

try {
    # Run Python script
    & "C:\Users\Administrator\Desktop\Github Repos\python-scripts\.venv\Scripts\python.exe" telethon_link_resolver.py
    $exitCode = $LASTEXITCODE
    
    if ($exitCode -eq 0) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Pipeline completed successfully" -ForegroundColor Green
    } else {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Pipeline completed with exit code: $exitCode" -ForegroundColor Yellow
    }
} catch {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Error: $_" -ForegroundColor Red
    $exitCode = 1
}

Pop-Location
exit $exitCode
