# Core Path Resolution
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Definition
# Current script is in 'dataset_builder'. Parent is 'python-zipper' root.
$projectRoot = (Get-Item $scriptPath).Parent.FullName
$targetParentPath = Join-Path $projectRoot ".downloaded"

# Environment patches to prevent Hugging Face / PyTorch thread hangs on Windows
$env:KMP_DUPLICATE_LIB_OK = "TRUE"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"

if (-not (Test-Path -Path $targetParentPath)) {
    Write-Error "Target path does not exist: $targetParentPath"
    Exit
}

# Create a dedicated processing directory outside of the download root
$processingPath = Join-Path $projectRoot ".processing"
if (-not (Test-Path -Path $processingPath)) {
    $null = New-Item -ItemType Directory -Path $processingPath -Force
}

$pythonExe = Join-Path $projectRoot ".venv\Scripts\python.exe"

# FIXED: Appended '\*' to the path. Get-ChildItem requires a path wildcard to make -Include evaluate correctly.
$zipFiles = @(Get-ChildItem -Path "$targetParentPath\*" -File -Include "*.zip", "*.rar", "*.7z")

if ($zipFiles.Count -eq 0) {
    Write-Warning "No .zip, .rar, or .7z archives found inside: $targetParentPath"
    #if (Test-Path -Path $processingPath) { Remove-Item -Path $processingPath -Recurse -Force }
    #Exit
}

Write-Host "Found $($zipFiles.Count) archives to process."

foreach ($zip in $zipFiles) {
    $zipBaseName = $zip.BaseName
    
    # Isolate staging area completely away from the target path
    $tempStagingPath = Join-Path $processingPath "staging_${zipBaseName}_$(Get-Random)"
    $null = New-Item -ItemType Directory -Path $tempStagingPath -Force

    try {
        Write-Host "Unpacking $($zip.Name)..."
        if ($zip.Extension -eq ".zip") {
            Expand-Archive -Path $zip.FullName -DestinationPath $tempStagingPath -Force
        } else {
            # Use native Windows tar binary for .rar and .7z packages
            & tar.exe -xf $zip.FullName -C $tempStagingPath 2>$null
        }
        
        $extractedFiles = Get-ChildItem -Path $tempStagingPath -File -Recurse
        
        foreach ($file in $extractedFiles) {
            $targetFileName = "$zipBaseName$($file.Extension)"
            $targetFullPath = Join-Path $targetParentPath $targetFileName

            # Explicit structural renaming loop
            $counter = 1
            while (Test-Path -Path $targetFullPath) {
                $targetFileName = "${zipBaseName}_${counter}$($file.Extension)"
                $targetFullPath = Join-Path $targetParentPath $targetFileName
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

# Clean up temporary processing root
if (Test-Path -Path $processingPath) {
    Remove-Item -Path $processingPath -Recurse -Force
}

# Resolve completed directory path
$completedPath = Join-Path $targetParentPath ".completed"
if (-not (Test-Path -Path $completedPath)) {
    $null = New-Item -ItemType Directory -Path $completedPath -Force
}

# Locate Czkawka CLI binary
$czkawkaBin = Join-Path $projectRoot "..\czkawka\czkawka_cli.exe"
if (-not (Test-Path -Path $czkawkaBin)) {
    $czkawkaBin = "c:\Users\Administrator\Desktop\czkawka\czkawka_cli.exe"
}

$resultsJsonPath = Join-Path $scriptPath "results.json"

Write-Host "Initiating image similarity matching phase..."
if (Test-Path -Path $czkawkaBin) {
    & $czkawkaBin image -d $targetParentPath -s 10 -D NONE --hash-size 16 -C $resultsJsonPath
    
    if (Test-Path -Path $resultsJsonPath) {
        Write-Host "Moving duplicate images to .completed folder..."
        & $pythonExe "$scriptPath\dedupe_mover.py" --results $resultsJsonPath --completed $completedPath
        Remove-Item -Path $resultsJsonPath -Force
    }
} else {
    Write-Warning "Czkawka CLI binary not found at $czkawkaBin."
}

# Run person detection using Hugging Face DETR model
#Write-Host "Filtering images by person presence using DETR-ResNet-50..."
#& $pythonExe "$scriptPath\face_detector.py" --dir $targetParentPath --completed $completedPath

# Relocate processed source files safely
Write-Host "Moving original source zip archives to .completed folder..."
foreach ($zip in $zipFiles) {
    if (Test-Path -Path $zip.FullName) {
        $destPath = Join-Path $completedPath $zip.Name
        $counter = 1
        $baseName = $zip.BaseName
        $extension = $zip.Extension
        while (Test-Path -Path $destPath) {
            $destPath = Join-Path $completedPath "${baseName}_${counter}${extension}"
            $counter++
        }
        Move-Item -Path $zip.FullName -Destination $destPath -Force
    }
}

Write-Host -NoNewLine 'Processing complete. Press any key to continue...';
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown');