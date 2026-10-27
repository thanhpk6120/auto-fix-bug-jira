@echo off
cd /d "%~dp0"
node daemon-control.js restart worker
if %ERRORLEVEL% equ 0 (
    echo.
    echo [OK] Da khoi dong lai Worker chay ngam. Cua so se tu dong dong sau 2 giay...
    timeout /t 2 >nul
    exit /b 0
) else (
    echo.
    echo [LOI] Khong restart duoc Worker.
    pause
    exit /b 1
)
