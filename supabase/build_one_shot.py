#!/usr/bin/env python3
"""Regenerates BKA_Supabase_Kurulum_Tek_Sorgu.sql from supabase/migrations/*.sql (in order).
Usage: python3 supabase/build_one_shot.py supabase/migrations "<header lines>" > supabase/BKA_Supabase_Kurulum_Tek_Sorgu.sql
"""
import sys, pathlib
mig_dir=pathlib.Path(sys.argv[1]); header=sys.argv[2]
parts=[header.rstrip('\n')+'\n']
for f in sorted(mig_dir.glob('*.sql')):
    t=f.read_text(encoding='utf-8')
    if t.startswith('-- ===='):
        parts.append('\n'+t.rstrip('\n')+'\n')
    else:
        parts.append('\n-- ============================================================\n-- '+f.name+'\n-- ============================================================\n'+t.rstrip('\n')+'\n')
sys.stdout.write(''.join(parts))
