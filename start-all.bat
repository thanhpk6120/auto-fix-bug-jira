@echo off
cd /d "%~dp0"
node daemon-control.js start all
if %ERRORLEVEL% equ 0 (
    echo.
    echo [OK] Toan bo he thong da duoc khoi dong chay ngam. Cua so se tu dong dong sau 2 giay...
    timeout /t 2 >nul
    exit /b 0
) else (
    echo.
    echo [LOI] Co loi khi khoi dong he thong.
    pause
    exit /b 1
)
