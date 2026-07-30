@echo off
setlocal EnableDelayedExpansion
title Tor Manager (Q to Clean)
color 0E

:: ====================================================
::  1. AGGRESSIVE PRE-CLEAN (The "Reset" Button)
:: ====================================================
echo  [1/4] Cleaning previous session data...
taskkill /F /IM tor.exe /T >nul 2>&1
timeout /t 1 /nobreak >nul
if exist "torrc_rotator" del /f /q "torrc_rotator" >nul 2>&1
if exist "data_rotator" rmdir /s /q "data_rotator" >nul 2>&1

:: ====================================================
::  2. CONFIGURATION
:: ====================================================
set "TOR_EXE=tor.exe"
set "START_PORT=20000"
set "PORT_COUNT=50"
set "TORRC_FILE=torrc_rotator"
set "DATA_DIR=data_rotator"
set "ROTATION_INTERVAL=300"

:: Create Data Directory
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
for %%I in ("%DATA_DIR%") do set "ABS_DATA_DIR=%%~fI"

:: ====================================================
::  3. GENERATE TORRC FILE
:: ====================================================
echo  [2/4] Generating configuration for %PORT_COUNT% ports...

echo DataDirectory %ABS_DATA_DIR%> "%TORRC_FILE%"
echo ControlPort 9051>> "%TORRC_FILE%"
echo HashedControlPassword 16:10954BDC9F31017560C961F779A5EBD8D759EF2AFD94C73E068DE90A2A>> "%TORRC_FILE%"
echo GeoIPFile geoip>> "%TORRC_FILE%"
echo GeoIPv6File geoip6>> "%TORRC_FILE%"

:: Loop to generate ports
set /a LOOP_LIMIT=%PORT_COUNT%-1
for /L %%i in (0, 1, !LOOP_LIMIT!) do (
    set /a CURRENT_PORT=%START_PORT% + %%i
    echo SocksPort !CURRENT_PORT!>> "%TORRC_FILE%"
)

:: ====================================================
::  4. START TOR
:: ====================================================
echo  [3/4] Starting Tor Engine...
start /b "" "%TOR_EXE%" -f "%TORRC_FILE%" >nul 2>&1

echo  [4/4] Waiting for Tor to connect...
timeout /t 5 /nobreak >nul

:: ====================================================
::  5. MAIN LOOP
:: ====================================================
:LOOP
    cls
    echo ========================================================
    echo  TOR PROXY MANAGER
    echo ========================================================
    echo  [+] Status:      RUNNING
    echo  [+] Proxy:       127.0.0.1:%START_PORT% (and %PORT_COUNT% others)
    echo  [+] Auto-Rotate: Every 5 Minutes (%ROTATION_INTERVAL%s)
    echo.
    echo  [!] COMMANDS:
    echo      [R] : Force New IPs (Rotate NOW)
    echo      [Q] : KILL TOR AND CLEAN EVERYTHING
    echo.
    
    echo  [%TIME%] Active. Waiting for timer...
    
    :: CHOICE:
    :: /C RQ  -> List of allowed keys (R and Q)
    :: /N     -> Hides the [R,Q]? prompt
    :: /T 300 -> Waits 300 seconds
    :: /D R   -> If time runs out, Default to 'R' (Rotate)
    
    choice /C RQ /N /T %ROTATION_INTERVAL% /D R /M "Press 'R' to Rotate, or 'Q' to Quit..."
    
    :: Logic:
    :: If ErrorLevel = 2, User pressed 'Q'
    :: If ErrorLevel = 1, User pressed 'R' (or timer ran out)
    
    if errorlevel 2 goto CLEANUP
    if errorlevel 1 goto ROTATE

:ROTATE
    echo.
    echo  [%TIME%] ♻️  Sending NEWNYM Signal to Tor...
    
    :: PowerShell to send signal to port 9051
    powershell -Command "$c=New-Object System.Net.Sockets.TcpClient('127.0.0.1',9051);$s=$c.GetStream();$w=New-Object System.IO.StreamWriter($s);$w.AutoFlush=$true;$w.WriteLine('AUTHENTICATE \"mypassword\"');$w.WriteLine('SIGNAL NEWNYM');$c.Close()" >nul 2>&1
    
    echo  [%TIME%] ✅  IPs Rotated. Refilling circuits...
    timeout /t 2 /nobreak >nul
    goto LOOP

:: ====================================================
::  6. CLEANUP & EXIT
:: ====================================================
:CLEANUP
echo.
echo ========================================================
echo  STOPPING AND CLEANING...
echo ========================================================

:: 1. Kill Tor
echo  [!] Killing Tor process...
taskkill /F /IM tor.exe /T >nul 2>&1

:: 2. Delete Files
echo  [!] Deleting temporary files...
timeout /t 1 /nobreak >nul
if exist "%TORRC_FILE%" del /f /q "%TORRC_FILE%"
if exist "%DATA_DIR%" rmdir /s /q "%DATA_DIR%"

echo.
echo  [OK] System Clean. Goodbye.
timeout /t 2 /nobreak >nul
exit