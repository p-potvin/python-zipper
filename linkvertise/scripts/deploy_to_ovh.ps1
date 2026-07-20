# Created: Tue, 30 Jun 2026 03:43
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$OvhHost = "ubuntu@100.67.25.118",
    [string]$RemoteAppDir = "/opt/vw-linkvertise",
    [string]$RemoteDataDir = "/srv/vw-linkvertise",
    [string]$ProfileSource = "C:\Users\Administrator\Desktop\Programming\mullvad_wireguard_windows_ca_all",
    [string[]]$Profiles = @(
        "ca-mtr-wg-004.conf",
        "ca-mtr-wg-201.conf",
        "ca-mtr-wg-202.conf",
        "ca-mtr-wg-301.conf",
        "ca-mtr-wg-302.conf",
        "ca-mtr-wg-303.conf",
        "ca-mtr-wg-304.conf",
        "ca-mtr-wg-305.conf",
        "ca-mtr-wg-306.conf",
        "ca-mtr-wg-307.conf",
        "ca-mtr-wg-308.conf",
        "ca-tor-wg-001.conf",
        "ca-tor-wg-002.conf",
        "ca-tor-wg-201.conf",
        "ca-tor-wg-202.conf",
        "ca-tor-wg-203.conf",
        "ca-tor-wg-204.conf",
        "ca-tor-wg-205.conf",
        "ca-tor-wg-206.conf",
        "ca-tor-wg-207.conf",
        "ca-van-wg-201.conf",
        "ca-van-wg-202.conf",
        "ca-van-wg-301.conf",
        "ca-van-wg-302.conf",
        "ca-yyc-wg-201.conf",
        "ca-yyc-wg-202.conf"
    )
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "This script prepares commands for OVH deployment. It does not print WireGuard profile contents."
Write-Host "Target: $OvhHost"
Write-Host "App: $RemoteAppDir"
Write-Host "Data: $RemoteDataDir"

foreach ($Profile in $Profiles) {
    $Path = Join-Path $ProfileSource $Profile
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing selected profile filename: $Profile"
    }
}

$RemoteScript = @"
set -eu
ts=`$(date '+%a_%d_%b_%Y_%H-%M')
sudo mkdir -p '$RemoteAppDir' '$RemoteDataDir/input' '$RemoteDataDir/downloads' '$RemoteDataDir/state' '$RemoteDataDir/logs' '$RemoteDataDir/artifacts' '$RemoteAppDir/mullvad-profiles'
if [ -f '$RemoteAppDir/docker-compose.yml' ]; then sudo cp '$RemoteAppDir/docker-compose.yml' "$RemoteAppDir/docker-compose.yml.bak-`$ts"; fi
"@

if ($PSCmdlet.ShouldProcess($OvhHost, "create remote directories and timestamped backups")) {
    $RemoteScript | ssh $OvhHost "tr -d '\r' | bash"
    Write-Host "Remote directories prepared. Copy code with scp/rsync, then copy selected profile files without printing contents."
}
else {
    Write-Host $RemoteScript
    Write-Host "Selected profile filenames:"
    $Profiles | ForEach-Object { Write-Host " - $_" }
}
