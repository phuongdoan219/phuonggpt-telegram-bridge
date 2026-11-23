@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0telegram.ps1" -Action Setup
echo.
pause
