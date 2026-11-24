@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steam-sync.ps1" %*
pause
