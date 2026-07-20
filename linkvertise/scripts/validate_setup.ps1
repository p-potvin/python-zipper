# Created: Tue, 30 Jun 2026 03:43
[CmdletBinding()]
param(
    [string]$ProfileSource = "C:\Users\Administrator\Desktop\Backups\mullvad_wireguard_windows_ca_all",
    [switch]$EnableFlaresolverrHealthCheck
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $Root

$Required = @(
    "$Root\src\linkvertise_downloader\cli.py",
    "$Root\docker\docker-compose.yml",
    "$Root\input\links.example.txt",
    "$Root\config.example.toml"
)

foreach ($Path in $Required) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing required file: $Path"
    }
}

$TrackedConf = git -C $RepoRoot ls-files -- 'linkvertise/*.conf' 'linkvertise/**/*.conf'
if ($TrackedConf) {
    throw "Tracked WireGuard config files are not allowed: $TrackedConf"
}

$env:PYTHONPATH = "$Root\src"
python -m linkvertise_downloader.cli profiles --source $ProfileSource --dry-run | Out-Host
python -m linkvertise_downloader.cli --input "$Root\input\links.example.txt" --max-links 2 --dry-run | Out-Host

if ($EnableFlaresolverrHealthCheck) {
    Write-Host "Flaresolverr health check must remain explicit and bounded; run from OVH runtime when ready."
}
