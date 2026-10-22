@echo off
title Jira-AutoFix-Dashboard
cd /d "%~dp0"

echo ========================================================
echo   KHOI DONG JIRA AUTO-FIX WORKER WEB DASHBOARD
echo ========================================================

if not exist ".env" (
    echo [CANH BAO] Khong tim thay file .env tai thu muc goc!
    echo Vui long tao file .env truoc khi chay.
    pause
    exit /b 1
)

echo [INFO] Dang khoi dong Web Dashboard tai cong 8880...
echo [INFO] Truy cap: http://localhost:8880 hoac http://10.30.1.207:8880
echo.

node --env-file=.env dashboard.js
if %ERRORLEVEL% neq 0 (
    echo.
    echo [LOI] Dashboard da dung voi ma loi %ERRORLEVEL%.
    pause
)
