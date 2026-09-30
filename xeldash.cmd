@echo off
rem Double-click me to set up or start xelDash. Runs xeldash.ps1 without the PowerShell script policy getting in the way.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0xeldash.ps1" %*
set EXITCODE=%ERRORLEVEL%
rem Keep the window open when it was double-clicked (no arguments), so the messages can be read.
if "%~1"=="" pause
exit /b %EXITCODE%
