@echo off
setlocal EnableDelayedExpansion
rem ============================================================
rem  ST Git Backup - one-click server plugin installer (Windows)
rem  Run from the installed extension folder. It finds the
rem  SillyTavern root by walking up to config.yaml, then copies
rem  the server plugin and enables enableServerPlugins.
rem  Works for extensions installed under either
rem  public\scripts\extensions\third-party\ or data\<user>\extensions\.
rem ============================================================

echo === ST Git Backup: server plugin installer ===

set "DIR=%~dp0"
set "ST_ROOT="

for /l %%N in (1,1,10) do (
    if not defined ST_ROOT (
        if exist "!DIR!config.yaml" (
            set "ST_ROOT=!DIR!"
        ) else (
            for %%I in ("!DIR!..") do set "DIR=%%~fI\"
        )
    )
)

if not defined ST_ROOT (
    echo [X] Could not find the SillyTavern root folder -- config.yaml not found.
    echo     Manual steps: copy this whole folder to SillyTavern\plugins\st-git-backup\
    echo     then set enableServerPlugins: true in config.yaml.
    pause
    exit /b 1
)

echo SillyTavern root: !ST_ROOT!
set "DEST=%ST_ROOT%plugins\st-git-backup"

echo Copying server plugin to: %DEST%
robocopy "%~dp0." "%DEST%" /E /XD .git /NFL /NDL /NJH /NJS >nul
if errorlevel 8 (
    echo [X] Copy failed - check permissions and try again.
    pause
    exit /b 1
)

echo Enabling server plugins in config.yaml...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = '%ST_ROOT%config.yaml'; (Get-Content $f) -replace '^enableServerPlugins:\s*false\s*$', 'enableServerPlugins: true' | Set-Content $f"

findstr /c:"enableServerPlugins: true" "%ST_ROOT%config.yaml" >nul
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
