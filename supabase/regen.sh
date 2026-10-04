#!/usr/bin/env bash
# Tek seferlik kurulum betiğini migrations/ klasöründen yeniden üretir (başlık korunur).
set -euo pipefail
cd "$(dirname "$0")"
H="$(head -3 BKA_Supabase_Kurulum_Tek_Sorgu.sql)"
python3 build_one_shot.py migrations "$H" > BKA_Supabase_Kurulum_Tek_Sorgu.sql.tmp
mv BKA_Supabase_Kurulum_Tek_Sorgu.sql.tmp BKA_Supabase_Kurulum_Tek_Sorgu.sql
