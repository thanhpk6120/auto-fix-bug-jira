@echo off
cd /d "%~dp0"
node daemon-control.js restart dashboard
if %ERRORLEVEL% equ 0 (
    echo.
    echo [OK] Da khoi dong lai Dashboard chay ngam. Cua so se tu dong dong sau 2 giay...
    timeout /t 2 >nul
    exit /b 0
) else (
    echo.
    echo [LOI] Khong restart duoc Dashboard.
    pause
    exit /b 1
)
