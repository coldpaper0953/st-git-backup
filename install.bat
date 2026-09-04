@echo off
setlocal EnableExtensions
rem ============================================================
rem  ST Git Backup - one-click server plugin installer (Windows)
rem  Run this from the installed UI extension folder:
rem  SillyTavern\public\scripts\extensions\third-party\st-git-backup\
rem  It copies the server plugin to SillyTavern\plugins\st-git-backup
rem  and turns on enableServerPlugins in config.yaml.
rem ============================================================

echo === ST Git Backup: server plugin installer ===

set "SRC=%~dp0"
set "ST_ROOT=%SRC%..\..\..\..\.."

pushd "%ST_ROOT%" 2>nul
if errorlevel 1 (
    echo [X] Cannot locate the SillyTavern root folder.
    echo     Run this script from the installed extension folder:
    echo     SillyTavern\public\scripts\extensions\third-party\st-git-backup\
    pause
    exit /b 1
)
set "ST_ROOT=%CD%"
popd

if not exist "%ST_ROOT%\config.yaml" (
    echo [X] config.yaml not found under "%ST_ROOT%" - unexpected folder layout.
    pause
    exit /b 1
)

set "DEST=%ST_ROOT%\plugins\st-git-backup"

echo Copying server plugin to: %DEST%
robocopy "%SRC%." "%DEST%" /E /XD .git /NFL /NDL /NJH /NJS >nul
if errorlevel 8 (
    echo [X] Copy failed - check permissions and try again.
    pause
    exit /b 1
)

echo Enabling server plugins in config.yaml...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = '%ST_ROOT%\config.yaml'; (Get-Content $f) -replace '^enableServerPlugins:\s*false\s*$', 'enableServerPlugins: true' | Set-Content $f"

findstr /c:"enableServerPlugins: true" "%ST_ROOT%\config.yaml" >nul
if errorlevel 1 (
    echo [!] Could not edit config.yaml automatically.
    echo     Please open it and set:  enableServerPlugins: true
) else (
    echo [OK] enableServerPlugins is enabled.
)

echo.
echo ==============================================
echo  Done! Now:
echo    1. Restart SillyTavern
echo    2. Open the Extensions panel, find "Git Backup ^& Restore"
echo    3. Fill in your repository URL and click Save / Backup
echo ==============================================
pause
