@echo off
cd /d "%~dp0"
node daemon-control.js stop worker
echo.
echo Cua so se tu dong dong sau 2 giay...
timeout /t 2 >nul
exit /b 0
