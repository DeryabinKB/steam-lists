@echo off
echo Steam must be closed (tray - Exit).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0steam-sync.ps1" -Export
pause
