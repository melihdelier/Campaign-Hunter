#!/usr/bin/env python3
from __future__ import annotations
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parent
CATALOG = ROOT / 'data' / 'catalog.json'
VERDICT = ROOT / 'data' / 'catalog_guard.json'


def guard_allows_publish(verdict_path: Path | None = None) -> tuple[bool, str]:
    """catalog_guard.py çalıştıysa kararına uy. Dosya yoksa (yerel kullanım) yayına izin ver."""
    verdict_path = verdict_path or VERDICT
    if not verdict_path.exists():
        return True, 'kalite kapısı kararı yok (yerel kullanım)'
    try:
        v = json.loads(verdict_path.read_text(encoding='utf-8'))
    except Exception as e:
        return False, f'kalite kapısı kararı okunamadı: {e}'
    if not v.get('publish', False):
        return False, f"kalite kapısı: {v.get('verdict')} — {' '.join(v.get('reasons') or [])}"
    return True, f"kalite kapısı: {v.get('verdict')}"


def build_body(payload: dict, now: datetime | None = None) -> dict:
    # PostgREST upsert yalnız gönderilen kolonları günceller; updated_at açıkça gönderilmezse ilk eklemedeki
    # değerde kalıyordu. Snapshot tazeliği bu alana bakılarak gösterildiği için her yayında yenilenir.
    now = now or datetime.now(timezone.utc)
    return {'id': 1, 'payload': payload, 'updated_at': now.isoformat()}


def main() -> int:
    url = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
    key = os.environ.get('SUPABASE_SECRET_KEY') or os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or ''
    if not url or not key:
        print('SUPABASE_URL / SUPABASE_SECRET_KEY yok; bulut katalog yayını atlandı.')
        return 0
    ok, why = guard_allows_publish()
    if not ok:
        print(f'Supabase katalog yayını atlandı; mevcut son başarılı snapshot korunuyor ({why}).')
        return 0
    if not CATALOG.exists():
        print(f'Katalog bulunamadı: {CATALOG}', file=sys.stderr); return 2
    payload = json.loads(CATALOG.read_text(encoding='utf-8'))
    if (payload.get('meta') or {}).get('partial') or not payload.get('campaigns'):
        print('Katalog yarım/boş; Supabase yayını atlandı.', file=sys.stderr)
        return 0
    body = json.dumps(build_body(payload), ensure_ascii=False).encode('utf-8')
    req = Request(
        f'{url}/rest/v1/catalog_snapshots?on_conflict=id', data=body, method='POST',
        headers={
            'apikey': key,
            'Authorization': f'Bearer {key}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal',
        }
    )
    try:
        with urlopen(req, timeout=30) as r:
            print(f'Supabase katalog snapshot yayınlandı (HTTP {r.status}; {why}).')
    except HTTPError as e:
        print(e.read().decode('utf-8', errors='replace'), file=sys.stderr)
        return 3
    return 0

if __name__ == '__main__': raise SystemExit(main())
