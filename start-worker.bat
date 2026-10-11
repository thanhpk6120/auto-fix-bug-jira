@echo off
title Jira-AutoFix-Worker
cd /d "%~dp0"

echo ========================================================
echo   KHOI DONG JIRA AUTO-FIX WORKER
echo ========================================================

if not exist ".env" (
    echo [CANH BAO] Khong tim thay file .env tai thu muc goc!
    echo Vui long tao file .env (copy tu .env.example) truoc khi chay.
    echo.
    pause
    exit /b 1
)

echo [INFO] Dang khoi dong Singleton Master Worker (worker.js)...
echo [INFO] Luu y: Cau hinh MAX_CONCURRENT_JOBS nam trong file .env
echo.

node --env-file=.env worker.js
if %ERRORLEVEL% neq 0 (
    echo.
    echo [LOI] Worker da dung voi ma loi %ERRORLEVEL%.
    pause
)
