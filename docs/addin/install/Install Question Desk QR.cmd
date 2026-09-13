@echo off
rem Installs the Question Desk QR add-in for PowerPoint (this Windows account only).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
pause
