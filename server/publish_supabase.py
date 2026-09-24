#!/usr/bin/env python3
from __future__ import annotations
import json, os, sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parent
CATALOG = ROOT / 'data' / 'catalog.json'

def main() -> int:
    url = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
    key = os.environ.get('SUPABASE_SECRET_KEY') or os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or ''
    if not url or not key:
        print('SUPABASE_URL / SUPABASE_SECRET_KEY yok; bulut katalog yayını atlandı.')
        return 0
    if not CATALOG.exists():
        print(f'Katalog bulunamadı: {CATALOG}', file=sys.stderr); return 2
    payload = json.loads(CATALOG.read_text(encoding='utf-8'))
    body = json.dumps({'id':1, 'payload':payload}, ensure_ascii=False).encode('utf-8')
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
            print(f'Supabase katalog snapshot yayınlandı (HTTP {r.status}).')
    except HTTPError as e:
        print(e.read().decode('utf-8', errors='replace'), file=sys.stderr)
        return 3
    return 0

if __name__ == '__main__': raise SystemExit(main())
