@echo off
rem Mini-player installer: runs install.ps1 (PowerShell) from this folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
