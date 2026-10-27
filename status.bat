@echo off
cd /d "%~dp0"
node daemon-control.js status all
echo.
pause
