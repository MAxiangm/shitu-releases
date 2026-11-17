@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0.recovery\runtime\electron.exe" "%~dp0scripts\tasks.cjs" %*
exit /b %errorlevel%
