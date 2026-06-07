# Core Path Resolution: Targets the .downloaded directory relative to the project root
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectRoot = (Get-Item $scriptPath).Parent.FullName
$targetParentPath = Join-Path $projectRoot ".downloaded"

# Auto-create .downloaded folder if missing
if (-not (Test-Path -Path $targetParentPath)) {
    $null = New-Item -ItemType Directory -Path $targetParentPath -Force
}

# Resolve Python Virtual Environment interpreter path
$pythonExe = Join-Path $projectRoot ".venv\Scripts\python.exe"

# Collect .zip files inside .downloaded directory
$zipFiles = Get-ChildItem $targetParentPath -Filter *.zip -File

# Initialize Windows Shell COM layer for native duplicate renaming routines
$shellApp = New-Object -ComObject Shell.Application
$parentFolderNamespace = $shellApp.NameSpace($targetParentPath)

Write-Host "Processing archives into target directory: $targetParentPath"

foreach ($zip in $zipFiles) {
    $zipBaseName = $zip.BaseName
    
    # Create isolated temporary staging inside parent directory for extraction
    $tempStagingPath = Join-Path $targetParentPath "staging_${zipBaseName}_$(Get-Random)"
    $null = New-Item -ItemType Directory -Path $tempStagingPath -Force

    try {
        Write-Host "Trying to unpack $zip."
        
        # Unpack target archive 
        Expand-Archive -Path $zip.FullName -DestinationPath $tempStagingPath -Force
        
        Write-Host "$zip has been unpacked."
        
        # Gather all child files nested within extraction root
        $extractedFiles = Get-ChildItem -Path $tempStagingPath -File -Recurse
        
        foreach ($file in $extractedFiles) {
            # Construct destination layout using original zip name + original file extension
            $targetFileName = $zipBaseName + $file.Extension
            $targetFullPath = Join-Path $targetParentPath $targetFileName

            if (Test-Path -Path $targetFullPath) {
                # Collision: Forward payload through the Shell Namespace to trigger standard Windows "(1)" suffix rules
                $stagingFolderNamespace = $shellApp.NameSpace($file.DirectoryName)
                $shellFile = $stagingFolderNamespace.ParseName($file.Name)
                
                # CopyHere Options: 0x0010 (Auto-rename collisions) + 0x0400 (Mute progress dialog UI)
                $parentFolderNamespace.CopyHere($shellFile, 0x0010 + 0x0400)
                
                # Clear raw staging target copy manually to unlock directory cleanup
                Remove-Item -Path $file.FullName -Force
            } else {
                # Safe path: Direct structural move
                Move-Item -Path $file.FullName -Destination $targetFullPath -Force
            }
        }
    }
    catch {
        Write-Error "Processing execution fault encountered on archive $($zip.Name): $_"
    }
    finally {
        # Teardown current staging path
        if (Test-Path -Path $tempStagingPath) {
            Remove-Item -Path $tempStagingPath -Recurse -Force
        }
    }
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

# Deduplication Processing via Czkawka CLI
Write-Host "Initiating image similarity matching phase..."
if (Test-Path -Path $czkawkaBin) {
    # -d directory context, -s similarity threshold (10), -D NONE (Only record, do not delete), -C results.json
    & $czkawkaBin image -d $targetParentPath -s 10 -D NONE --hash-size 16 -C $resultsJsonPath
    
    # Run python script to parse results.json and move duplicate files
    if (Test-Path -Path $resultsJsonPath) {
        Write-Host "Moving duplicate images to .completed folder..."
        & $pythonExe "$scriptPath\dedupe_mover.py" --results $resultsJsonPath --completed $completedPath
        Remove-Item -Path $resultsJsonPath -Force
    }
} else {
    Write-Warning "Czkawka CLI binary not found at $czkawkaBin. Skipping deduplication pass."
}

# Run person detection using Hugging Face DETR model
Write-Host "Filtering images by person presence using DETR-ResNet-50..."
& $pythonExe "$scriptPath\face_detector.py" --dir $targetParentPath --completed $completedPath

# Move original source zip archives to completed folder instead of deleting them
Write-Host "Moving original source zip archives to .completed folder..."
foreach ($zip in $zipFiles) {
    if (Test-Path -Path $zip.FullName) {
        $destPath = Join-Path $completedPath $zip.Name
        # Avoid file collision on move
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

Write-Host -NoNewLine 'Press any key to continue...';
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown');
