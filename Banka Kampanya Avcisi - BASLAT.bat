@echo off
setlocal EnableExtensions
cd /d "%~dp0"
call "scripts\start_app.bat"
exit /b %ERRORLEVEL%
