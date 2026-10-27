@echo off
cd /d "%~dp0"
node daemon-control.js start dashboard
if %ERRORLEVEL% equ 0 (
    echo.
    echo [OK] Dashboard dang chay ngam (an hoan toan). Cua so se tu dong dong sau 2 giay...
    timeout /t 2 >nul
    exit /b 0
) else (
    echo.
    echo [LOI] Khong khoi dong duoc Dashboard. Xem chi tiet trong evidences/dashboard.log
    pause
    exit /b 1
)
