@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
set "JOB=%CD%\scripts\refresh_campaigns_now.bat"
schtasks /Create /F /SC DAILY /ST 08:00 /TN "BankaKampanyaAvcisi-0800" /TR "\"%JOB%\""
if errorlevel 1 goto :fail
schtasks /Create /F /SC DAILY /ST 18:00 /TN "BankaKampanyaAvcisi-1800" /TR "\"%JOB%\""
if errorlevel 1 goto :fail
echo.
echo 08:00 ve 18:00 tarama gorevleri kuruldu.
echo Log: server\data\scheduled_refresh.log
pause
exit /b 0
:fail
echo.
echo Gorev kurulurken hata olustu. Gerekirse bu dosyayi Yonetici olarak calistir.
pause
exit /b 1
