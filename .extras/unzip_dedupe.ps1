[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [Alias("Directory")]
    [string]$targetDir = (Get-Location).Path
)

# 1. Infrastructure Paths (Static to Script Location)
$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$projectRoot = (Get-Item $scriptDir).Parent.FullName
$pythonExe = Join-Path $projectRoot ".venv\Scripts\python.exe"
$resultsJsonPath = Join-Path $scriptDir "results.json"
$dedupeScript = Join-Path $scriptDir "dedupe_mover.py"
$czkawkaBin = Join-Path $env:USERPROFILE "Desktop\czkawka\czkawka_cli.exe"

# 2. Data Paths (Relative to Shell Invocation Context)
$processingPath = Join-Path $targetDir ".processing"
$completedPath = Join-Path $targetDir ".completed"
$duplicatePath = Join-Path $targetDir ".duplicates"

if (-not (Test-Path -Path $targetDir)) {
    Write-Error "Target path does not exist: $targetDir"
    Exit
}

# Create processing target inside caller context
if (-not (Test-Path -Path $processingPath)) {
    $null = New-Item -ItemType Directory -Path $processingPath -Force
}

# Gather targets out of the caller context subfolder
$zipFiles = @(Get-ChildItem -Path (Join-Path $targetDir "*") -File -Include "*.zip", "*.rar", "*.7z")

if ($zipFiles.Count -eq 0) {
    Write-Warning "No .zip, .rar, or .7z archives found inside: $targetDir"
}

Write-Host "Found $($zipFiles.Count) archives to process."

foreach ($zip in $zipFiles) {
    $zipBaseName = $zip.BaseName
    $tempStagingPath = Join-Path $processingPath "staging_${zipBaseName}_$(Get-Random)"
    $null = New-Item -ItemType Directory -Path $tempStagingPath -Force

    try {
        Write-Host "Unpacking $($zip.Name)..."
        if ($zip.Extension -eq ".zip") {
            Expand-Archive -Path $zip.FullName -DestinationPath $tempStagingPath -Force
        }
        else {
            & tar.exe -xf $zip.FullName -C $tempStagingPath 2>$null
        }
        
        $extractedFiles = Get-ChildItem -Path $tempStagingPath -File -Recurse
        
        foreach ($file in $extractedFiles) {
            $targetFileName = "${zipBaseName}$($file.Extension)"
            $targetFullPath = Join-Path $targetDir $targetFileName

            $counter = 1
            while (Test-Path -Path $targetFullPath) {
                $targetFileName = "${zipBaseName}_${counter}$($file.Extension)"
                $targetFullPath = Join-Path $targetDir $targetFileName
                $counter++
            }
            Move-Item -Path $file.FullName -Destination $targetFullPath -Force
        }
    }
    catch {
        Write-Error "Execution fault on archive $($zip.Name): $_"
    }
    finally {
        if (Test-Path -Path $tempStagingPath) {
            Remove-Item -Path $tempStagingPath -Recurse -Force
        }
    }
}

if (Test-Path -Path $processingPath) {
    Remove-Item -Path $processingPath -Recurse -Force
}

# Structural enforcement: Ensure paths exist before binary execution or item mutation
foreach ($path in $duplicatePath, $completedPath) {
    if (-not (Test-Path -Path $path)) {
        $null = New-Item -ItemType Directory -Path $path -Force
    }
}

Write-Host "Initiating image similarity matching phase..."
if (Test-Path -Path $czkawkaBin) {
    & $czkawkaBin image -d $targetDir -s 25 -D NONE --hash-size 16 -p $resultsJsonPath -R
    
    if (Test-Path -Path $resultsJsonPath) {
        Write-Host "Moving duplicate images to .duplicates folder..."
        & $pythonExe $dedupeScript --results $resultsJsonPath --completed $duplicatePath
        
        # Verify path existence prior to deletion to handle downstream structural cleanup anomalies
        if (Test-Path -Path $resultsJsonPath) {
            Remove-Item -Path $resultsJsonPath -Force
        }
    }
}
else {
    Write-Warning "Czkawka CLI binary not found at $czkawkaBin."
}

Write-Host "Moving original source zip archives to .completed folder..."
foreach ($zip in $zipFiles) {
    if (Test-Path -Path $zip.FullName) {
        $destPath = Join-Path $completedPath $zip.Name
        $counter = 1
        $baseName = $zip.BaseName
        $extension = $zip.Extension
        
        # Collisions handle sequence loop
        while (Test-Path -Path $destPath) {
            $destPath = Join-Path $completedPath "${baseName}_${counter}${extension}"
            $counter++
        }
        Move-Item -Path $zip.FullName -Destination $destPath -Force
    }
}

Write-Host -NoNewLine 'Processing complete. Press any key to continue...';
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown');