@echo off
rem Double-click to open Omega Manager. Installs what it needs the first time.
cd /d "%~dp0"

set "ELECTRON=node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
    where npm >nul 2>nul
    if errorlevel 1 (
        echo Node.js is required but was not found.
        echo Install it from https://nodejs.org and run this again.
        pause
        exit /b 1
    )
    echo First run: installing Omega Manager, this can take a minute...
    call npm install
    if not exist "%ELECTRON%" call node node_modules\electron\install.js
    if not exist "%ELECTRON%" (
        echo.
        echo Installing failed. See the messages above.
        pause
        exit /b 1
    )
)

start "" "%ELECTRON%" .
