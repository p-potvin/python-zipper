[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$hostName = 'com.pythonzipper.flmgr'
$registryPath = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
$installDirectory = Join-Path $env:LOCALAPPDATA 'VaultWares\PythonZipper\NativeHost'

if ($Uninstall) {
    if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath -Force }
    Write-Output "Unregistered Firefox native host $hostName."
    return
}

$sourceHost = Join-Path $PSScriptRoot 'native_host.py'
if (-not (Test-Path -LiteralPath $sourceHost -PathType Leaf)) { throw "Native host source not found: $sourceHost" }
$pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
if ($pythonCommand) {
    $pythonPath = $pythonCommand.Source
} else {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $venvPython = Join-Path $repoRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        throw 'Python was not found on PATH and the repository virtual environment is unavailable.'
    }
    $pythonPath = (Resolve-Path -LiteralPath $venvPython).Path
}

New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
$installedHost = Join-Path $installDirectory 'native_host.py'
$launcherPath = Join-Path $installDirectory 'native_host.cmd'
$manifestPath = Join-Path $installDirectory "$hostName.json"
Copy-Item -LiteralPath $sourceHost -Destination $installedHost -Force
$launcher = "@echo off`r`n`"$pythonPath`" -u `"$installedHost`"`r`n"
Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding Ascii -NoNewline
[ordered]@{
    name = $hostName
    description = 'VaultWares Python Zipper File Explorer host'
    path = $launcherPath
    type = 'stdio'
    allowed_extensions = @('zipper-vdh@vaultwares')
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
New-Item -Path $registryPath -Force | Out-Null
Set-Item -LiteralPath $registryPath -Value $manifestPath

$registeredManifest = (Get-Item -LiteralPath $registryPath).GetValue('')
$installed = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($registeredManifest -ne $manifestPath -or $installed.name -ne $hostName -or $installed.path -ne $launcherPath) {
    throw 'Installed native-host registration failed validation.'
}
Write-Output "Registered Firefox native host $hostName."
Write-Output "Manifest: $manifestPath"
Write-Output "Python: $pythonPath"
