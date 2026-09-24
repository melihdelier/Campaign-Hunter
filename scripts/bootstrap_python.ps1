$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RuntimeDir = Join-Path $Root 'runtime\python'
$PythonExe = Join-Path $RuntimeDir 'python.exe'
$Version = '3.13.0'
$ZipName = "python-$Version-embed-amd64.zip"
$Url = "https://www.python.org/ftp/python/$Version/$ZipName"
$TempZip = Join-Path $env:TEMP $ZipName

if (Test-Path $PythonExe) {
    try {
        & $PythonExe -c "import sys, ssl, urllib.request; print(sys.version)" | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Yerel Python runtime hazir: $PythonExe"
            exit 0
        }
    } catch {}
}

Write-Host "Python 3 bulunamadi. Banka Kampanya Avcisi icin portable Python indiriliyor..."
Write-Host "Kaynak: $Url"
Write-Host "Bu islem sisteminize Python kurmaz; sadece uygulama klasorune acar."

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
try {
    Invoke-WebRequest -Uri $Url -OutFile $TempZip -UseBasicParsing
} catch {
    Write-Host ""
    Write-Host "Portable Python indirilemedi: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Internet erisimini kontrol edip tekrar deneyin."
    exit 2
}

try {
    Expand-Archive -Path $TempZip -DestinationPath $RuntimeDir -Force
} finally {
    Remove-Item $TempZip -Force -ErrorAction SilentlyContinue
}

$Pth = Join-Path $RuntimeDir 'python313._pth'
if (Test-Path $Pth) {
    $Lines = @(Get-Content $Pth)
    if ($Lines -notcontains '..\..\server') {
        # Add project server directory so app_server can import campaign_crawler
        $Lines += '..\..\server'
        Set-Content -Path $Pth -Value $Lines -Encoding ASCII
    }
}

if (-not (Test-Path $PythonExe)) {
    Write-Host "Portable Python acilamadi; python.exe bulunamadi." -ForegroundColor Red
    exit 3
}

& $PythonExe -c "import sys, ssl, urllib.request; import campaign_crawler; print(sys.version)"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Portable Python dogrulama testi basarisiz." -ForegroundColor Red
    exit 4
}

Write-Host "Portable Python hazir."
exit 0
