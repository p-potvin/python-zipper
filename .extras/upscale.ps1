param (
    [Parameter(Mandatory=$true)][string]$InputDir,
    [Parameter(Mandatory=$true)][string]$ModelPath,
    [string]$PythonScript = ".\upscale.py"
)

if (-not (Test-Path $InputDir)) {
    Write-Error "Target input directory does not exist: $InputDir"
    exit 1
}

if (-not (Test-Path $ModelPath)) {
    Write-Error "Specified model path does not exist: $ModelPath"
    exit 1
}

python $PythonScript --input_dir "$InputDir" --model_path "$ModelPath"