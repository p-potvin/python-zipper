$scriptPath = "C:\Users\Administrator\Desktop\Github Repos\python-scripts\telegram\telegram_link_resolver.py"
$pythonExe  = "C:\Users\Administrator\Desktop\Github Repos\python-scripts\.venv\Scripts\python.exe"
$workingDir = "C:\Users\Administrator\Desktop\Github Repos\python-scripts\telegram"

$action = New-ScheduledTaskAction -Execute $pythonExe -Argument $scriptPath -WorkingDirectory $workingDir
$trigger = New-ScheduledTaskTrigger -Daily -At "2:00AM"
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "TelegramLinkResolver" -Description "Extracts, resolves, and saves URLs from Telegram result.json every day." -User $env:USERNAME

Write-Host "Scheduled task 'TelegramLinkResolver' successfully created! It will run daily at 2:00 AM."