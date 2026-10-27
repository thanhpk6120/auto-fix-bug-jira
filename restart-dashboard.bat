@echo off
cd /d "%~dp0"

echo ========================================================
echo   KHOI DONG LAI JIRA AUTO-FIX WORKER WEB DASHBOARD
echo ========================================================

echo [1/2] Dang tim va dung tien trinh dashboard cu...

:: Cach 1: Dung theo Tieu de cua so (Window Title)
taskkill /F /FI "WINDOWTITLE eq Jira-AutoFix-Dashboard*" /T >nul 2>&1

:: Cach 2: Dung tien trinh node dang chay file dashboard.js
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*node*dashboard.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

:: Cach 3: Giai phong cong 8880 neu con bi chiem dung
:: Doi 1 giay de he thong don dep port va tien trinh
ping 127.0.0.1 -n 2 >nul 2>&1

echo [2/2] Dang khoi dong lai dashboard trong cua so moi...

:: Khoi dong lai qua start-dashboard.bat
start "Jira-AutoFix-Dashboard" cmd /c "%~dp0start-dashboard.bat"

echo.
echo [THANH CONG] Da restart dashboard tai port 8880.
echo Truy cap: http://localhost:8880 hoac http://10.30.1.207:8880
ping 127.0.0.1 -n 3 >nul 2>&1
