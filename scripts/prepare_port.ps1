$ErrorActionPreference = 'Stop'
$Port = 8765
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ExpectedVersion = (Get-Content (Join-Path $Root 'VERSION.txt') -Raw).Trim()
$Base = "http://127.0.0.1:$Port"

function Get-ListenerPid {
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($conn) { return [int]$conn.OwningProcess }
    } catch {}
    try {
        $line = netstat -ano -p tcp | Select-String -Pattern "127\.0\.0\.1:$Port\s+.*LISTENING\s+(\d+)" | Select-Object -First 1
        if ($line -and $line.Matches.Count -gt 0) { return [int]$line.Matches[0].Groups[1].Value }
    } catch {}
    return $null
}

$ExistingVersion = $null
try {
    $v = Invoke-RestMethod -Uri "$Base/api/version" -Method Get -TimeoutSec 2
    $ExistingVersion = [string]$v.version
} catch {
    try {
        $h = Invoke-RestMethod -Uri "$Base/api/health" -Method Get -TimeoutSec 2
        if ($h.ok) { $ExistingVersion = 'legacy-app-without-version-endpoint' }
    } catch {}
}

$PidOnPort = Get-ListenerPid
if (-not $PidOnPort) {
    Write-Host "Port $Port bos. Yeni surum baslatilacak."
    exit 0
}

if ($ExistingVersion -eq $ExpectedVersion) {
    Write-Host "Banka Kampanya Avcisi $ExpectedVersion zaten calisiyor."
    try { Start-Process "$Base/?v=$ExpectedVersion" } catch {}
    exit 20
}

$proc = $null
try { $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$PidOnPort" -ErrorAction Stop } catch {}
$cmd = if ($proc) { [string]$proc.CommandLine } else { '' }
$name = if ($proc) { [string]$proc.Name } else { '' }

# Eski bir Banka Kampanya Avcisi app_server.py ise güvenle kapat.
if ($cmd -match '(?i)app_server\.py' -and ($name -match '(?i)python|py')) {
    Write-Host "Eski uygulama servisi bulundu (PID $PidOnPort, surum: $ExistingVersion). Kapatiliyor..."
    try { Stop-Process -Id $PidOnPort -Force -ErrorAction Stop } catch {
        Write-Host "Eski servis kapatilamadi: $($_.Exception.Message)" -ForegroundColor Red
        exit 31
    }
    Start-Sleep -Milliseconds 700
    if (Get-ListenerPid) {
        Write-Host "Port $Port hala kullaniliyor. Uygulama baslatilmadi." -ForegroundColor Red
        exit 32
    }
    exit 0
}

Write-Host "Port $Port baska bir uygulama tarafindan kullaniliyor (PID $PidOnPort)." -ForegroundColor Red
Write-Host "Guvenlik nedeniyle bu process otomatik kapatilmadi." -ForegroundColor Yellow
exit 30
