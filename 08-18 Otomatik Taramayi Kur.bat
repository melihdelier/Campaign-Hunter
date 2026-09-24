@echo off
setlocal EnableExtensions
cd /d "%~dp0"
call "scripts\install_twice_daily_schedule.bat"
exit /b %ERRORLEVEL%
