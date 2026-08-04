@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\connect-codex.ps1" %*
set "CROSSAGENT_EXIT=%ERRORLEVEL%"
if not defined CROSSAGENT_NO_PAUSE pause
exit /b %CROSSAGENT_EXIT%
