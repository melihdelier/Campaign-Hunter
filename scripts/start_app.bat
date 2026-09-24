@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
title Banka Kampanya Avcisi

echo Banka Kampanya Avcisi baslatiliyor...
for /f "usebackq delims=" %%V in ("VERSION.txt") do set "APP_VERSION=%%V"
echo Surum: %APP_VERSION%

REM Eski bir surum 8765 portunda acik kaldiysa yanlis paketi kullanmamak icin temizle.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\prepare_port.ps1"
set "PORT_RC=%ERRORLEVEL%"
if "%PORT_RC%"=="20" exit /b 0
if not "%PORT_RC%"=="0" (
  echo.
  echo Uygulama portu hazirlanamadi. Yukaridaki mesaji kontrol edin.
  pause
  exit /b %PORT_RC%
)

REM 1) Uygulamaya ozel portable runtime varsa onu kullan.
if exist "runtime\python\python.exe" goto :run_bundled

REM 2) Windows Python Launcher gercekten Python 3 calistirabiliyor mu?
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys" >nul 2>nul
  if not errorlevel 1 goto :run_py
)

REM 3) PATH uzerindeki python gercekten calisiyor mu?
where python >nul 2>nul
if not errorlevel 1 (
  python -c "import sys" >nul 2>nul
  if not errorlevel 1 goto :run_python
)

REM 4) Yaygin Conda/standalone Python konumlari.
for %%P in (
  "%USERPROFILE%\anaconda3\python.exe"
  "%USERPROFILE%\miniconda3\python.exe"
  "%LOCALAPPDATA%\anaconda3\python.exe"
  "%LOCALAPPDATA%\miniconda3\python.exe"
  "%ProgramData%\anaconda3\python.exe"
  "%ProgramData%\miniconda3\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
  "%ProgramFiles%\Python313\python.exe"
  "%ProgramFiles%\Python312\python.exe"
  "%ProgramFiles%\Python311\python.exe"
) do (
  if exist "%%~P" (
    "%%~P" -c "import sys" >nul 2>nul
    if not errorlevel 1 (
      echo Python: %%~P
      "%%~P" server\app_server.py
      set "RC=%ERRORLEVEL%"
      if not "%RC%"=="0" pause
      exit /b %RC%
    )
  )
)

REM 5) Hic Python yoksa resmi Python.org embedded runtime'ini uygulama klasorune indir.
echo.
echo Calisan Python 3 bulunamadi.
echo Ilk calistirmada uygulamaya ozel portable Python hazirlanacak.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\bootstrap_python.ps1"
if errorlevel 1 goto :bootstrap_fail
if not exist "runtime\python\python.exe" goto :bootstrap_fail
goto :run_bundled

:run_bundled
echo Python: uygulamaya ozel portable runtime
"runtime\python\python.exe" server\app_server.py
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%

:run_py
echo Python: py -3
py -3 server\app_server.py
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%

:run_python
echo Python: python
python server\app_server.py
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%

:bootstrap_fail
echo.
echo Portable Python otomatik hazirlanamadi.
echo Internet baglantisini kontrol edip start_app.bat dosyasini tekrar calistirin.
echo Sistem Python kurmaniz zorunlu degildir.
pause
exit /b 1
