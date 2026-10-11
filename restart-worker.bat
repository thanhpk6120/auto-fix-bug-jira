@echo off
cd /d "%~dp0"

echo ========================================================
echo   KHOI DONG LAI JIRA AUTO-FIX WORKER
echo ========================================================

echo [1/2] Dang tim va dung tien trinh worker cu...

:: Cach 1: Dung theo Tieu de cua so (Window Title)
taskkill /F /FI "WINDOWTITLE eq Jira-AutoFix-Worker*" /T >nul 2>&1

:: Cach 2: Dung tien trinh node dang chay file worker.js (tranh kill nham web/api)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*node*worker.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

:: Doi 1 giay de he thong don dep tien trinh
timeout /t 1 /nobreak >nul

echo [2/2] Dang khoi dong lai worker trong cua so moi...

:: Khoi dong lai qua start-worker.bat
start "Jira-AutoFix-Worker" cmd /c "%~dp0start-worker.bat"

echo.
echo [THANH CONG] Da restart worker. Tien trinh moi dang chay trong cua so CMD khac.
timeout /t 3 >nul
