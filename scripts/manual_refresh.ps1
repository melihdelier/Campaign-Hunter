$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:8765"

try {
  Invoke-RestMethod -Uri "$base/api/health" -Method Get -TimeoutSec 3 | Out-Null
} catch {
  exit 10
}

Write-Host "Uygulama servisi acik. Canli tarama isteniyor..."
try {
  Invoke-RestMethod -Uri "$base/api/refresh" -Method Post -TimeoutSec 5 | Out-Null
  Write-Host "Tarama baslatildi."
} catch {
  if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 409) {
    Write-Host "Bir tarama zaten calisiyor. Mevcut tarama izlenecek; ikinci tarama baslatilmadi."
  } else {
    Write-Host "Yenileme istegi gonderilemedi: $($_.Exception.Message)"
    exit 1
  }
}

$last = ""
while ($true) {
  Start-Sleep -Seconds 2
  try { $s = Invoke-RestMethod -Uri "$base/api/status" -Method Get -TimeoutSec 5 } catch { continue }
  $line = "Durum: $($s.state) | Banka: $($s.current_bank) | Kaynak: $($s.current_source) | Ilerleme: $($s.source_done)/$($s.source_total) | Katalog: $($s.campaign_count) | Hata: $($s.error_count)"
  if ($line -ne $last) { Write-Host $line; $last = $line }
  if ($s.state -ne "running") {
    if ($s.state -eq "ok" -or $s.state -eq "partial_error") {
      Write-Host "Tarama tamamlandi. Katalog: $($s.campaign_count) kampanya."
      exit 0
    }
    Write-Host "Tarama $($s.state) durumuyla bitti."
    exit 1
  }
}
