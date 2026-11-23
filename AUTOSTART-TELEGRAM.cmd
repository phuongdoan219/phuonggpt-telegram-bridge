@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bridge-control.ps1" -Action EnableAutostart
pause
