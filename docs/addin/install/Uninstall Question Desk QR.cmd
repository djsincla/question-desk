@echo off
rem Removes the Question Desk QR add-in for PowerPoint.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-windows.ps1"
pause
