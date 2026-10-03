"""v1.4 — Supabase şema / RLS / tetikleyici testleri (gerçek PostgreSQL üzerinde).

Geçici bir PostgreSQL kümesi açar, Supabase rol/auth taklidini (supabase/tests/supabase_stub.sql) kurar,
supabase/migrations/*.sql dosyalarını SIRAYLA uygular ve kullanıcı izolasyonunu SQL düzeyinde doğrular:
A kullanıcısı B'nin profil/banka/kart/segment/tercih satırlarını okuyamaz, değiştiremez, silemez — API isteği
elle değiştirilse bile (RLS veritabanında uygulanır). Ayrıca 'en kötü durum yetkileri' (anon/authenticated'a
tüm tablolar GRANT edilmiş) altında da RLS'in tek başına izolasyonu sağladığı test edilir.

PostgreSQL ikilileri bulunamazsa yerelde atlanır; CI ortamında (CI=true) atlanmaz, başarısız olur.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = sorted((ROOT / 'supabase' / 'migrations').glob('*.sql'))
STUB = ROOT / 'supabase' / 'tests' / 'supabase_stub.sql'

A = str(uuid.UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
B = str(uuid.UUID('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))


def find_pg_bin() -> Path | None:
    env = os.environ.get('PG_BIN')
    if env and (Path(env) / 'initdb').exists():
        return Path(env)
    for base in sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True):
        if (base / 'initdb').exists() and (base / 'postgres').exists():
            return base
    w = shutil.which('initdb')
    return Path(w).parent if w else None


def free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class PG:
    def __init__(self, pg_bin: Path):
        self.bin = pg_bin
        self.dir = Path(tempfile.mkdtemp(prefix='ch-rls-'))
        self.data = self.dir / 'data'
        self.port = free_port()
        self.env = {**os.environ, 'PGHOST': str(self.dir), 'PGPORT': str(self.port), 'PGUSER': 'postgres', 'PGDATABASE': 'postgres'}
        # initdb root olarak çalışmaz: gerekirse ayrı kullanıcıya düş
        self.run_as = None
        if os.geteuid() == 0:
            self.run_as = 'postgres' if subprocess.run(['id', 'postgres'], capture_output=True).returncode == 0 else None
            if self.run_as:
                shutil.chown(self.dir, user=self.run_as)

    def _cmd(self, args):
        return (['runuser', '-u', self.run_as, '--'] + args) if self.run_as else args

    def start(self):
        subprocess.run(self._cmd([str(self.bin / 'initdb'), '-D', str(self.data), '-U', 'postgres', '-A', 'trust', '--no-sync']),
                       check=True, capture_output=True, env=self.env)
        subprocess.run(self._cmd([str(self.bin / 'pg_ctl'), '-D', str(self.data), '-l', str(self.dir / 'log'), '-w', '-o',
                                  f"-p {self.port} -k {self.dir} -c listen_addresses='' -c fsync=off"]) + ['start'],
                       check=True, capture_output=True, env=self.env)

    def stop(self):
        subprocess.run(self._cmd([str(self.bin / 'pg_ctl'), '-D', str(self.data), '-m', 'immediate', 'stop']), capture_output=True, env=self.env)
        shutil.rmtree(self.dir, ignore_errors=True)

    def psql(self, sql: str, check=True):
        r = subprocess.run(self._cmd([str(self.bin / 'psql'), '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', str(self.dir), '-p', str(self.port),
                                      '-U', 'postgres', '-d', 'postgres', '-c', sql]), capture_output=True, text=True, env=self.env)
        if check and r.returncode != 0:
            raise AssertionError(f'SQL failed: {sql}\n{r.stderr}')
        return r

    def file(self, path: Path):
        r = subprocess.run(self._cmd([str(self.bin / 'psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', str(self.dir), '-p', str(self.port),
                                      '-U', 'postgres', '-d', 'postgres', '-f', str(path)]), capture_output=True, text=True, env=self.env)
        if r.returncode != 0:
            raise AssertionError(f'{path.name} failed:\n{r.stderr}')
        return r

    # Belirli bir kullanıcı olarak (PostgREST'in yaptığı gibi: SET ROLE authenticated + JWT claims)
    def as_user(self, uid: str | None, sql: str, check=True):
        role = 'authenticated' if uid else 'anon'
        claims = json.dumps({'sub': uid, 'role': role}) if uid else '{}'
        pre = f"set role {role}; select set_config('request.jwt.claims', '{claims}', false);"
        r = self.psql(pre + sql, check=check)
        if r.returncode == 0:
            out = [l for l in r.stdout.strip().splitlines() if l != claims]
            r.out = out[-1] if out else ''
        return r


PG_BIN = find_pg_bin()


@unittest.skipIf(PG_BIN is None and not os.environ.get('CI'), 'PostgreSQL bulunamadı (yerelde atlandı; CI zorunlu)')
class SupabaseRlsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if PG_BIN is None:
            raise RuntimeError('PostgreSQL binaries are required in CI for RLS tests')
        cls.pg = PG(PG_BIN)
        cls.pg.start()
        cls.pg.file(STUB)
        for m in MIGRATIONS:
            cls.pg.file(m)
        cls.pg.psql(f"insert into auth.users(id,email) values ('{A}','a@example.com'),('{B}','b@example.com');")
        # A: TEB + Infinite + Ultra, YKB + Crystal ; B: QNB + Private
        a = cls.pg.as_user
        a(A, f"""insert into public.profiles(user_id, display_name, onboarding_completed_at) values ('{A}','A', now());
                insert into public.user_banks(user_id, bank_id) select '{A}', id from public.banks where code in ('teb','ykb');
                insert into public.user_cards(user_id, card_product_id) select '{A}', id from public.card_products where code in ('teb-infinite','ykb-crystal');
                insert into public.user_profile_attributes(user_id, dimension_code, option_code) values ('{A}','teb_tier','ultra'),('{A}','crystal_band','band_1');
                insert into public.user_preferences(user_id, preferences) values ('{A}', '{{"staleAfterDays":3}}');""")
        a(B, f"""insert into public.profiles(user_id, display_name) values ('{B}','B');
                insert into public.user_banks(user_id, bank_id) select '{B}', id from public.banks where code = 'qnb';
                insert into public.user_cards(user_id, card_product_id) select '{B}', id from public.card_products where code = 'qnb-ms-private';
                insert into public.user_profile_attributes(user_id, dimension_code, option_code) values ('{B}','qnb_segment','private');
                insert into public.user_preferences(user_id, preferences) values ('{B}', '{{}}');""")

    @classmethod
    def tearDownClass(cls):
        cls.pg.stop()

    USER_TABLES = ['profiles', 'user_banks', 'user_cards', 'user_profile_attributes', 'user_preferences']

    def count(self, uid, table, where=''):
        return int(self.pg.as_user(uid, f'select count(*) from public.{table} {where};').out)

    # ---- okuma izolasyonu
    def test_user_reads_only_own_rows(self):
        for t in self.USER_TABLES:
            self.assertGreater(self.count(A, t), 0, t)
            self.assertEqual(self.count(A, t, f"where user_id = '{B}'"), 0, f'A must not read B in {t}')
            self.assertEqual(self.count(B, t, f"where user_id = '{A}'"), 0, f'B must not read A in {t}')
        self.assertEqual(self.count(A, 'profiles'), 1)
        self.assertEqual(self.pg.as_user(A, 'select display_name from public.profiles;').out, 'A')

    def test_anon_reads_nothing(self):
        for t in self.USER_TABLES:
            r = self.pg.as_user(None, f'select count(*) from public.{t};', check=False)
            self.assertTrue(r.returncode != 0 or r.out == '0', f'anon must not read {t}')

    # ---- yazma izolasyonu
    def test_user_cannot_modify_or_delete_other_users_rows(self):
        r = self.pg.as_user(B, f"update public.profiles set display_name = 'hacked' where user_id = '{A}' returning 1;")
        self.assertEqual(r.out, '')
        r = self.pg.as_user(B, f"delete from public.user_cards where user_id = '{A}' returning 1;")
        self.assertEqual(r.out, '')
        r = self.pg.as_user(B, f"delete from public.user_profile_attributes where user_id = '{A}' returning 1;")
        self.assertEqual(r.out, '')
        r = self.pg.as_user(B, f"update public.user_preferences set preferences = '{{}}' where user_id = '{A}' returning 1;")
        self.assertEqual(r.out, '')
        self.assertEqual(self.pg.as_user(A, 'select display_name from public.profiles;').out, 'A')
        self.assertEqual(self.count(A, 'user_cards'), 2)

    def test_user_cannot_insert_rows_for_another_user_or_reassign_ownership(self):
        for sql in [
            f"insert into public.profiles(user_id) values ('{A}');",
            f"insert into public.user_banks(user_id, bank_id) select '{A}', id from public.banks where code = 'qnb';",
            f"insert into public.user_preferences(user_id) values ('{A}');",
            f"insert into public.user_profile_attributes(user_id, dimension_code, option_code) values ('{A}','teb_tier','plus');",
            f"update public.profiles set user_id = '{A}' where user_id = '{B}';",
        ]:
            r = self.pg.as_user(B, sql, check=False)
            self.assertNotEqual(r.returncode, 0, sql)
        self.assertEqual(self.pg.as_user(A, "select option_code from public.user_profile_attributes where dimension_code = 'teb_tier';").out, 'ultra')

    # ---- bütünlük
    def test_card_requires_selected_bank(self):
        r = self.pg.as_user(B, f"insert into public.user_cards(user_id, card_product_id) select '{B}', id from public.card_products where code = 'teb-infinite';", check=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('requires its bank', r.stderr)

    def test_invalid_option_rejected(self):
        r = self.pg.as_user(B, f"insert into public.user_profile_attributes(user_id, dimension_code, option_code) values ('{B}','qnb_segment','galaxy');", check=False)
        self.assertNotEqual(r.returncode, 0)

    def test_add_and_remove_bank_and_card_with_cascade(self):
        u = str(uuid.uuid4())
        self.pg.psql(f"insert into auth.users(id,email) values ('{u}','c@example.com');")
        self.pg.as_user(u, f"""insert into public.user_banks(user_id, bank_id) select '{u}', id from public.banks where code in ('akbank','teb');
            insert into public.user_cards(user_id, card_product_id) select '{u}', id from public.card_products where code in ('akbank-wings-black','akbank-wings-elite','teb-infinite');
            insert into public.user_profile_attributes(user_id, dimension_code, option_code) values ('{u}','wings_tier','black'),('{u}','teb_tier','plus');""")
        self.assertEqual(self.count(u, 'user_cards'), 3)
        # kart çıkar
        self.pg.as_user(u, "delete from public.user_cards where card_product_id = (select id from public.card_products where code = 'akbank-wings-elite');")
        self.assertEqual(self.count(u, 'user_cards'), 2)
        # banka çıkar → kartı ve bankaya bağlı segment de gider; diğer banka etkilenmez
        self.pg.as_user(u, "delete from public.user_banks where bank_id = (select id from public.banks where code = 'akbank');")
        self.assertEqual(self.pg.as_user(u, 'select string_agg(cp.code, \',\') from public.user_cards uc join public.card_products cp on cp.id = uc.card_product_id;').out, 'teb-infinite')
        self.assertEqual(self.pg.as_user(u, 'select string_agg(dimension_code, \',\' order by dimension_code) from public.user_profile_attributes;').out, 'teb_tier')
        # diğer kullanıcıların verisi etkilenmedi
        self.assertEqual(self.count(A, 'user_cards'), 2)

    def test_profile_persists_across_sessions_and_onboarding_flag(self):
        # yeni "oturum" = yeni bağlantı + aynı JWT sub
        r = self.pg.as_user(A, 'select onboarding_completed_at is not null from public.profiles;')
        self.assertEqual(r.out, 't')
        self.assertEqual(self.pg.as_user(B, 'select onboarding_completed_at is null from public.profiles;').out, 't')

    # ---- ana veri
    def test_master_data_readable_by_authenticated_not_writable(self):
        self.assertGreater(self.count(A, 'profile_dimensions'), 0)
        self.assertGreater(self.count(A, 'profile_dimension_options'), 0)
        r = self.pg.as_user(A, "insert into public.profile_dimensions(code,label,kind) values ('x','x','other');", check=False)
        self.assertNotEqual(r.returncode, 0)
        r = self.pg.as_user(A, "update public.banks set name = 'x' returning 1;", check=False)
        self.assertTrue(r.returncode != 0 or r.out == '')
        r = self.pg.as_user(None, 'select count(*) from public.profile_dimensions;', check=False)
        self.assertNotEqual(r.returncode, 0)

    def test_seed_matches_bundled_client_catalog(self):
        js = subprocess.run(['node', '-e', "import('./profile-catalog.js').then(m=>process.stdout.write(JSON.stringify(m.BUNDLED_PROFILE_CATALOG)))"],
                            cwd=ROOT / 'web', capture_output=True, text=True)
        if js.returncode != 0:
            self.skipTest('node not available')
        cat = json.loads(js.stdout)
        q = lambda s: json.loads(self.pg.psql(s).stdout.strip() or '[]')
        db_banks = {r['code']: r for r in q("select coalesce(json_agg(json_build_object('code',code,'name',name,'sortOrder',sort_order)),'[]') from public.banks where code in (select code from public.banks);")}
        for b in cat['banks']:
            self.assertEqual(db_banks[b['code']]['name'], b['name']); self.assertEqual(db_banks[b['code']]['sortOrder'], b['sortOrder'])
        db_cards = {r['code']: r for r in q("select json_agg(json_build_object('code',cp.code,'name',cp.name,'bankCode',b.code,'family',cp.family,'sortOrder',cp.sort_order)) from public.card_products cp join public.banks b on b.id=cp.bank_id;")}
        for c in cat['cardProducts']:
            self.assertEqual({k: db_cards[c['code']][k] for k in ('name', 'bankCode', 'family', 'sortOrder')}, {k: c[k] for k in ('name', 'bankCode', 'family', 'sortOrder')})
        dims = {r['code']: r for r in q("""select json_agg(json_build_object('code',d.code,'label',d.label,'kind',d.kind,'bankCode',b.code,'engineBinding',d.engine_binding,'settingKey',d.setting_key,'sortOrder',d.sort_order,
                 'cardCodes',(select coalesce(json_agg(cp.code order by cp.code),'[]') from public.profile_dimension_cards x join public.card_products cp on cp.id=x.card_product_id where x.dimension_code=d.code),
                 'options',(select json_agg(json_build_object('code',o.code,'label',o.label,'engineLabel',o.engine_label,'sortOrder',o.sort_order) order by o.sort_order) from public.profile_dimension_options o where o.dimension_code=d.code)))
                 from public.profile_dimensions d left join public.banks b on b.id=d.bank_id;""")}
        self.assertEqual(set(dims), {d['code'] for d in cat['dimensions']})
        for d in cat['dimensions']:
            got = dims[d['code']]
            for k in ('label', 'kind', 'bankCode', 'engineBinding', 'settingKey', 'sortOrder'):
                self.assertEqual(got[k], d[k], f"{d['code']}.{k}")
            self.assertEqual(got['cardCodes'], sorted(d['cardCodes']))
            self.assertEqual(got['options'], [{k: o[k] for k in ('code', 'label', 'engineLabel', 'sortOrder')} for o in sorted(d['options'], key=lambda o: o['sortOrder'])])
        # v1.4.3: tarihli ölçütler birebir
        crit = q("""select coalesce(json_agg(json_build_object('dimensionCode',dimension_code,'optionCode',option_code,'criteriaVersion',criteria_version,
                 'effectiveFrom',effective_from::text,'effectiveTo',effective_to::text,'displayLabel',display_label,'lowerBound',lower_bound::float8,'upperBound',upper_bound::float8,
                 'boundUnit',bound_unit,'sourceUrl',source_url,'sourceReference',source_reference,
                 'verifiedAt',to_char(verified_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) order by dimension_code, criteria_version, option_code),'[]')
                 from public.profile_option_criteria;""")
        bundled = sorted(cat['optionCriteria'], key=lambda r: (r['dimensionCode'], r['criteriaVersion'], r['optionCode']))
        self.assertEqual(crit, bundled)

    def test_migrations_007_008_are_repeatable(self):
        before = self.pg.psql('select (select count(*) from public.profile_dimension_options), (select count(*) from public.user_cards), (select count(*) from public.profiles);').stdout
        for m in MIGRATIONS:
            if m.name.startswith(('007', '008', '009', '010')):
                self.pg.file(m)
        after = self.pg.psql('select (select count(*) from public.profile_dimension_options), (select count(*) from public.user_cards), (select count(*) from public.profiles);').stdout
        self.assertEqual(before, after)

    def test_eligibility_only_binding_allowed_existing_rows_unchanged(self):
        before = self.pg.psql("select string_agg(code || ':' || engine_binding, ',' order by code) from public.profile_dimensions;").stdout
        self.pg.psql("""insert into public.profile_dimensions(code,label,kind,engine_binding) values ('test_elig_only','Test','other','eligibility_only');
                        insert into public.profile_dimension_options(dimension_code,code,label) values ('test_elig_only','yes','Evet');""")
        r = self.pg.psql("insert into public.profile_dimensions(code,label,kind,engine_binding) values ('test_bad','x','other','nonsense');", check=False)
        self.assertNotEqual(r.returncode, 0)
        # kullanıcı eligibility-only özniteliği kendi profiline yazabilir, başkası göremez
        self.pg.as_user(A, f"insert into public.user_profile_attributes(user_id,dimension_code,option_code) values ('{A}','test_elig_only','yes');")
        self.assertEqual(self.count(B, 'user_profile_attributes', "where dimension_code = 'test_elig_only'"), 0)
        self.pg.psql("delete from public.user_profile_attributes where dimension_code='test_elig_only'; delete from public.profile_dimensions where code='test_elig_only';")
        after = self.pg.psql("select string_agg(code || ':' || engine_binding, ',' order by code) from public.profile_dimensions;").stdout
        self.assertEqual(before, after)
        self.assertNotIn('eligibility_only', before)  # mevcut boyutlar değişmedi

    def test_one_shot_setup_contains_current_migrations(self):
        one_shot = (ROOT / 'supabase' / 'BKA_Supabase_Kurulum_Tek_Sorgu.sql').read_text(encoding='utf-8')
        for m in MIGRATIONS:
            self.assertIn(m.read_text(encoding='utf-8').strip(), one_shot, m.name)

    def test_every_user_table_has_rls_and_own_row_policies(self):
        rows = self.pg.psql("""select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
            join information_schema.columns col on col.table_schema=n.nspname and col.table_name=c.relname and col.column_name='user_id'
            where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;""").stdout.strip()
        self.assertEqual(rows, '', 'user-owned tables without RLS')
        for t in ['profiles', 'user_banks', 'user_profile_attributes', 'user_preferences']:
            cmds = set(self.pg.psql(f"select cmd from pg_policies where schemaname='public' and tablename='{t}';").stdout.split())
            self.assertEqual(cmds, {'SELECT', 'INSERT', 'UPDATE', 'DELETE'}, t)
            quals = self.pg.psql(f"select coalesce(qual,'') || ' ' || coalesce(with_check,'') from pg_policies where schemaname='public' and tablename='{t}';").stdout
            self.assertNotIn('true', quals.replace('auth.uid()', ''), f'permissive policy on {t}')

    def test_isolation_holds_even_with_worst_case_grants(self):
        # Supabase "otomatik expose" açık olsa / yanlış GRANT verilse bile RLS izolasyonu sağlamalı.
        self.pg.psql('grant all on all tables in schema public to anon, authenticated;')
        try:
            for t in self.USER_TABLES:
                self.assertEqual(self.count(B, t, f"where user_id = '{A}'"), 0, t)
                r = self.pg.as_user(None, f'select count(*) from public.{t};')
                self.assertEqual(r.out, '0', f'anon {t}')
            r = self.pg.as_user(B, f"delete from public.profiles where user_id = '{A}' returning 1;")
            self.assertEqual(r.out, '')
        finally:
            self.pg.psql('revoke all on all tables in schema public from anon, authenticated;')
            for m in MIGRATIONS:
                if m.name.startswith(('007', '008', '010')):
                    self.pg.file(m)
            self.pg.psql('grant select on table public.catalog_snapshots to anon, authenticated;')

    def test_existing_user_app_state_isolation(self):
        self.pg.as_user(A, f"insert into public.user_app_state(user_id, settings) values ('{A}', '{{\"x\":1}}');")
        self.assertEqual(self.count(B, 'user_app_state', f"where user_id = '{A}'"), 0)
        r = self.pg.as_user(B, f"update public.user_app_state set settings = '{{}}' where user_id = '{A}' returning 1;")
        self.assertEqual(r.out, '')


@unittest.skipIf(PG_BIN is None and not os.environ.get('CI'), 'PostgreSQL bulunamadı')
class ExistingProductionUpgradeTests(unittest.TestCase):
    """v1.2.x üretim veritabanına (001–007 uygulanmış, veri var) 008'in güvenle eklenmesi."""
    def fresh(self):
        pg = PG(PG_BIN); pg.start(); pg.file(STUB)
        for m in MIGRATIONS:
            if m.name < '008':  # v1.2.x üretim durumu: 001–007
                pg.file(m)
        pg.psql(f"insert into auth.users(id,email) values ('{A}','a@example.com');")
        pg.psql(f"""insert into public.user_app_state(user_id, settings, campaign_states) values ('{A}', '{{"tebTier":"ultra"}}', '{{"x":{{"remainingLimit":5}}}}');
                    insert into public.user_reward_profile(user_id) values ('{A}');
                    insert into public.catalog_snapshots(id, payload) values (1, '{{"campaigns":[1,2,3]}}');""")
        return pg

    def test_008_preserves_existing_production_data(self):
        pg = self.fresh()
        try:
            for m in MIGRATIONS:
                if m.name >= '008':  # 008 + sonrasını sırayla uygula
                    pg.file(m)
            self.assertEqual(pg.psql("select settings->>'tebTier' from public.user_app_state;").stdout.strip(), 'ultra')
            self.assertEqual(pg.psql("select campaign_states->'x'->>'remainingLimit' from public.user_app_state;").stdout.strip(), '5')
            self.assertEqual(pg.psql('select count(*) from public.user_reward_profile;').stdout.strip(), '1')
            self.assertEqual(pg.psql("select jsonb_array_length(payload->'campaigns') from public.catalog_snapshots;").stdout.strip(), '3')
            # anon catalog read still works (PWA catalog before login)
            self.assertEqual(pg.as_user(None, 'select count(*) from public.catalog_snapshots;').out, '1')
        finally:
            pg.stop()

    def test_008_is_atomic_and_refuses_duplicate_user_cards_without_data_loss(self):
        pg = self.fresh()
        try:
            pg.psql(f"""insert into public.user_cards(user_id, card_product_id, segment_label) select '{A}', id, 'x' from public.card_products where code='teb-infinite';
                        insert into public.user_cards(user_id, card_product_id, segment_label) select '{A}', id, 'y' from public.card_products where code='teb-infinite';""")
            with self.assertRaises(AssertionError) as ctx:
                pg.file(next(m for m in MIGRATIONS if m.name.startswith('008')))
            self.assertIn('duplicate', str(ctx.exception))
            self.assertEqual(pg.psql('select count(*) from public.user_cards;').stdout.strip(), '2')
            self.assertEqual(pg.psql("select to_regclass('public.profiles') is null;").stdout.strip(), 't', 'no partial schema left behind')
            self.assertEqual(pg.psql("select count(*) from information_schema.columns where table_name='banks' and column_name='sort_order';").stdout.strip(), '0')
        finally:
            pg.stop()


OLD_BAND_CODES = {'maximiles_band': ['under_1m', '1m_4m', '4m_8m', '8m_plus'], 'crystal_band': ['under_1m', '1m_6m', '6m_10m', '10m_plus']}


@unittest.skipIf(PG_BIN is None and not os.environ.get('CI'), 'PostgreSQL bulunamadı')
class OptionCriteriaMigrationTests(unittest.TestCase):
    """v1.4.3 / migration 010: nötr bant kodları, tarihli ölçütler, onay sürümü."""

    def setUp(self):
        self.pg = PG(PG_BIN); self.pg.start(); self.pg.file(STUB)

    def tearDown(self):
        self.pg.stop()

    def apply(self, pred):
        for m in MIGRATIONS:
            if pred(m.name):
                self.pg.file(m)

    def simulate_old_008_seed_with_user_data(self):
        """008'i v1.4.0–v1.4.2'deki (eşik kodlu) seed ile çalıştırmış bir veritabanı + kullanıcı seçimleri."""
        self.apply(lambda n: n < '009')
        self.pg.psql("delete from public.profile_dimension_options where dimension_code in ('maximiles_band','crystal_band');")
        rows = ','.join(f"('{d}','{c}','{c}','{c}',{(i + 1) * 10})" for d, codes in OLD_BAND_CODES.items() for i, c in enumerate(codes))
        self.pg.psql(f"insert into public.profile_dimension_options(dimension_code,code,label,engine_label,sort_order) values {rows};")
        self.pg.psql(f"insert into auth.users(id,email) values ('{A}','a@example.com'),('{B}','b@example.com');")
        self.pg.as_user(A, f"""insert into public.user_banks(user_id, bank_id) select '{A}', id from public.banks where code in ('isbank','ykb');
            insert into public.user_cards(user_id, card_product_id) select '{A}', id from public.card_products where code in ('is-maximiles-black','ykb-crystal');
            insert into public.user_profile_attributes(user_id, dimension_code, option_code, updated_at) values
              ('{A}','maximiles_band','1m_4m','2026-09-15T10:00:00Z'),('{A}','crystal_band','10m_plus','2026-09-16T10:00:00Z');""")
        self.pg.as_user(B, f"""insert into public.user_banks(user_id, bank_id) select '{B}', id from public.banks where code = 'isbank';
            insert into public.user_profile_attributes(user_id, dimension_code, option_code) values ('{B}','maximiles_band','8m_plus');""")
        # kullanımdan kalkmış eski tablo: varsayılanlar eski kodlar (004/005)
        self.pg.psql(f"insert into public.user_reward_profile(user_id) values ('{A}'); insert into public.user_reward_profile(user_id, maximiles_band, crystal_band) values ('{B}','1m_4m','6m_10m');")

    def test_upgrade_from_threshold_coded_seed_preserves_selections(self):
        self.simulate_old_008_seed_with_user_data()
        self.apply(lambda n: n >= '009')
        q = lambda sql: self.pg.psql(sql).stdout.strip()
        self.assertEqual(q(f"select string_agg(dimension_code||'='||option_code||'@'||criteria_version||'|'||to_char(confirmed_at at time zone 'UTC','YYYY-MM-DD'), ',' order by dimension_code) from public.user_profile_attributes where user_id='{A}';"),
                         'crystal_band=band_4@v1|2026-09-16,maximiles_band=band_2@v1|2026-09-15')
        self.assertEqual(q(f"select option_code||'@'||criteria_version from public.user_profile_attributes where user_id='{B}';"), 'band_4@v1')
        self.assertEqual(q("select string_agg(dimension_code||'.'||code, ',' order by dimension_code, code) from public.profile_dimension_options where dimension_code in ('maximiles_band','crystal_band');"),
                         'crystal_band.band_1,crystal_band.band_2,crystal_band.band_3,crystal_band.band_4,maximiles_band.band_1,maximiles_band.band_2,maximiles_band.band_3,maximiles_band.band_4')
        self.assertEqual(q(f"select maximiles_band||','||crystal_band from public.user_reward_profile where user_id='{A}';"), 'band_3,band_1')
        self.assertEqual(q(f"select maximiles_band||','||crystal_band from public.user_reward_profile where user_id='{B}';"), 'band_2,band_3')
        r = self.pg.psql(f"update public.user_reward_profile set maximiles_band='4m_8m' where user_id='{A}';", check=False)
        self.assertNotEqual(r.returncode, 0, 'old code must be rejected after 010')
        self.assert_no_old_codes_anywhere()
        # tekrar çalıştırılabilir: ikinci uygulama hiçbir şeyi değiştirmez
        before = q("select string_agg(user_id||dimension_code||option_code||coalesce(criteria_version,'')||coalesce(confirmed_at::text,''), ',' order by 1) from public.user_profile_attributes;")
        self.apply(lambda n: n.startswith('010'))
        self.assertEqual(before, q("select string_agg(user_id||dimension_code||option_code||coalesce(criteria_version,'')||coalesce(confirmed_at::text,''), ',' order by 1) from public.user_profile_attributes;"))

    def assert_no_old_codes_anywhere(self):
        q = lambda sql: self.pg.psql(sql).stdout
        olds = sorted({c for codes in OLD_BAND_CODES.values() for c in codes})
        lit = ','.join(f"'{c}'" for c in olds)
        self.assertEqual(q(f"select count(*) from public.profile_dimension_options where code in ({lit});").strip(), '0')
        self.assertEqual(q(f"select count(*) from public.user_profile_attributes where option_code in ({lit});").strip(), '0')
        self.assertEqual(q(f"select count(*) from public.profile_option_criteria where option_code in ({lit});").strip(), '0')
        defs = q("select string_agg(pg_get_constraintdef(oid), ' ') from pg_constraint where connamespace='public'::regnamespace;")
        defaults = q("select string_agg(column_default, ' ') from information_schema.columns where table_schema='public';")
        for c in olds:
            self.assertNotIn(f"'{c}'", defs, f'constraint still references {c}')
            self.assertNotIn(f"'{c}'", defaults, f'column default still uses {c}')

    def test_fresh_install_has_only_neutral_codes(self):
        self.apply(lambda n: True)
        self.assert_no_old_codes_anywhere()

    def test_crystal_criteria_cite_official_source_and_rerun_corrects_older_010(self):
        self.apply(lambda n: True)
        q = lambda sql: self.pg.psql(sql).stdout.strip()
        ok = "select count(*) from public.profile_option_criteria where dimension_code='crystal_band' and verified_at is not null and source_url like 'https://www.crystalcard.com.tr/%'"
        self.assertEqual(q(ok + ';'), '4')
        # 010'un önceki (doğrulanmamış Crystal) hâlini çalıştırmış veritabanı: güncel 010 yeniden çalıştırılınca düzelir
        self.pg.psql("update public.profile_option_criteria set verified_at=null, source_url='https://www.yapikredi.com.tr/x', source_reference='old' where dimension_code='crystal_band';")
        self.apply(lambda n: n.startswith('010'))
        self.assertEqual(q(ok + ';'), '4')
        self.assertIn("1 milyon TL - 6 milyon TL arasında", q("select source_reference from public.profile_option_criteria where dimension_code='crystal_band' and option_code='band_2';"))

    def test_criteria_master_data_rls_and_confirmation_fk(self):
        self.apply(lambda n: True)
        self.pg.psql(f"insert into auth.users(id,email) values ('{A}','a@example.com');")
        self.assertEqual(self.pg.as_user(A, 'select count(*) from public.profile_option_criteria;').out, '8')
        self.assertNotEqual(self.pg.as_user(None, 'select count(*) from public.profile_option_criteria;', check=False).returncode, 0)
        r = self.pg.as_user(A, "update public.profile_option_criteria set display_label='x' returning 1;", check=False)
        self.assertTrue(r.returncode != 0 or r.out == '')
        self.pg.as_user(A, f"""insert into public.user_banks(user_id, bank_id) select '{A}', id from public.banks where code='isbank';""")
        # var olmayan sürümle onay reddedilir; null sürüm (onay bilgisi yok) kabul edilir
        bad = self.pg.as_user(A, f"insert into public.user_profile_attributes(user_id,dimension_code,option_code,criteria_version,confirmed_at) values ('{A}','maximiles_band','band_2','v9',now());", check=False)
        self.assertNotEqual(bad.returncode, 0)
        self.pg.as_user(A, f"insert into public.user_profile_attributes(user_id,dimension_code,option_code,criteria_version,confirmed_at) values ('{A}','maximiles_band','band_2','v1',now());")
        # tutar sütunu yok: yalnız bant seçimi saklanır
        cols = self.pg.psql("select string_agg(column_name, ',') from information_schema.columns where table_name='user_profile_attributes';").stdout
        self.assertNotRegex(cols, r'amount|asset|balance|tutar')

    def test_new_criteria_version_does_not_rewrite_user_confirmation(self):
        self.apply(lambda n: True)
        self.pg.psql(f"insert into auth.users(id,email) values ('{A}','a@example.com');")
        self.pg.as_user(A, f"""insert into public.user_banks(user_id, bank_id) select '{A}', id from public.banks where code='isbank';
            insert into public.user_profile_attributes(user_id,dimension_code,option_code,criteria_version,confirmed_at) values ('{A}','maximiles_band','band_2','v1','2026-10-02T09:00:00Z');""")
        # Banka eşikleri değişti (ör. 2027-01-01'den itibaren): v1 kapanır, v2 eklenir. Seçenek KODLARI aynı kalır.
        self.pg.psql("""update public.profile_option_criteria set effective_to='2027-01-01' where dimension_code='maximiles_band' and criteria_version='v1';
            insert into public.profile_option_criteria(dimension_code,option_code,criteria_version,effective_from,display_label,lower_bound,upper_bound,source_url,verified_at)
            select dimension_code, option_code, 'v2', '2027-01-01', display_label||' (v2)', lower_bound*2, upper_bound*2, source_url, now()
              from public.profile_option_criteria where dimension_code='maximiles_band' and criteria_version='v1';""")
        self.assertEqual(self.pg.psql("select count(distinct option_code) from public.profile_option_criteria where dimension_code='maximiles_band';").stdout.strip(), '4')
        self.assertEqual(self.pg.as_user(A, "select option_code||'@'||criteria_version||'|'||to_char(confirmed_at at time zone 'UTC','YYYY-MM-DD') from public.user_profile_attributes;").out,
                         'band_2@v1|2026-10-02', 'the stored confirmation stays bound to the version it was given under')
        # iki sürümün de satırları korunur (geçmiş silinmez)
        self.assertEqual(self.pg.psql("select string_agg(distinct criteria_version, ',' order by criteria_version) from public.profile_option_criteria where dimension_code='maximiles_band';").stdout.strip(), 'v1,v2')


if __name__ == '__main__':
    unittest.main()
