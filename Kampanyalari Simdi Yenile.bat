@echo off
setlocal EnableExtensions
cd /d "%~dp0"
call "scripts\refresh_campaigns_now.bat"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo Pencereyi kapatabilirsin. Uygulamadaki katalog otomatik yenilenir.
) else (
  echo Hata olustu. Yukaridaki son satirlari bana gonderebilirsin.
)
pause
exit /b %RC%
