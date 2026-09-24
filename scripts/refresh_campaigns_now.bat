@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
title Banka Kampanya Avcisi - Kampanya Taramasi
if not exist "server\data" mkdir "server\data" >nul 2>nul

echo ============================================================
echo  BANKA KAMPANYA AVCISI - CANLI KAMPANYA TARAMASI
echo ============================================================
echo.

rem Uygulama servisi aciksa ayni taramayi API uzerinden baslat/izle.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\manual_refresh.ps1"
set "PRC=%ERRORLEVEL%"
if "%PRC%"=="0" exit /b 0
if not "%PRC%"=="10" exit /b %PRC%

echo Uygulama servisi acik degil. Tarama dogrudan calistirilacak.
echo.
set "PY="
if exist "runtime\python\python.exe" set "PY=runtime\python\python.exe"
if defined PY goto :run

where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys" >nul 2>nul
  if not errorlevel 1 (
    set "PY=py -3"
    goto :run
  )
)
where python >nul 2>nul
if not errorlevel 1 (
  python -c "import sys" >nul 2>nul
  if not errorlevel 1 (
    set "PY=python"
    goto :run
  )
)

echo Python hazirlaniyor...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\bootstrap_python.ps1"
if errorlevel 1 (
  echo Portable Python hazirlanamadi.
  exit /b 1
)
set "PY=runtime\python\python.exe"

:run
echo Kullanilan Python: %PY%
echo.
%PY% server\campaign_crawler.py
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo Tarama islemi tamamlandi.
) else if "%RC%"=="2" (
  echo Baska bir tarama zaten calisiyor. Ikinci tarama baslatilmadi.
  set "RC=0"
) else (
  echo Tarama hata ile sonlandi. Kod=%RC%
)
exit /b %RC%
