-- ============================================================
-- 011_master_data_coverage.sql  (Campaign Hunter v1.5.0)
-- Genel ana veri modeli + kapsam (EXPAND adımı; hiçbir şey silinmez/yeniden adlandırılmaz):
--  1) Yeni bankalar: Garanti BBVA, Ziraat Bankası, Halkbank, VakıfBank, DenizBank (yalnız banka kimliği).
--  2) public.card_programs: doğrulanmış kart programları/aileleri (Bonus, Bankkart, Paraf, Vakıfkart, Wings, Axess …).
--  3) public.card_products.program_code (nullable; mevcut ürünler korunur).
--  4) public.bank_coverage: banka başına bağımsız kapsam fasetleri (bir bankanın varlığı TAM destek demek değildir).
--  5) Wings / TEB seçeneklerinin GÖRÜNEN adları kademe adı olur (kodlar ve engine_label DEĞİŞMEZ: eski istemci uyumu).
-- Kullanıcı verisi değişmez. Ana veri tabloları kullanıcıya ait DEĞİLDİR (oturum açmış kullanıcı okur, yazamaz).
-- Önceki (v1.4.x) önbellekteki PWA etkilenmez: yeni tablo/kolonları okumaz; yeni bankalar kartsız görünür.
-- Tek transaction, tekrar çalıştırılabilir. Değerler web/profile-catalog.js ile birebir (test düzeneği doğrular).
-- ============================================================
begin;

-- ---------- 1) Bankalar ----------
insert into public.banks(code,name,sort_order) values
 ('akbank','Akbank',10),
 ('isbank','İş Bankası',20),
 ('qnb','QNB',30),
 ('teb','TEB',40),
 ('ykb','Yapı Kredi',50),
 ('garanti','Garanti BBVA',60),
 ('ziraat','Ziraat Bankası',70),
 ('halkbank','Halkbank',80),
 ('vakifbank','VakıfBank',90),
 ('denizbank','DenizBank',100)
on conflict (code) do update set name=excluded.name, sort_order=excluded.sort_order;

-- ---------- 2) Kart programları (global ana veri) ----------
create table if not exists public.card_programs (
  code text primary key check (code ~ '^[a-z0-9][a-z0-9-]*$'),
  bank_id uuid not null references public.banks(id) on delete cascade,
  name text not null,
  source_url text not null check (source_url ~ '^https://'),
  verified_at timestamptz,                         -- KAYNAK doğrulaması (global); null = çalışan tarayıcı kaynağı, ayrıca doğrulanmadı
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_card_programs_bank on public.card_programs(bank_id);

insert into public.card_programs(bank_id,code,name,source_url,verified_at,sort_order)
select b.id, v.code, v.name, v.source_url, v.verified_at::timestamptz, v.sort_order
from (values
 ('akbank','wings','Wings','https://www.wingscard.com.tr/kampanyalar',null,10),
 ('akbank','axess','Axess','https://www.axess.com.tr/axess/kampanyalar',null,20),
 ('isbank','maximiles','Maximiles','https://www.maximiles.com.tr/kampanyalar/tum-kampanyalar',null,10),
 ('qnb','qnb-card','QNB Card','https://www.qnbcard.com.tr/kampanyalar',null,10),
 ('qnb','miles-smiles-qnb','Miles&Smiles QNB','https://milesandsmilesqnb.com.tr/kampanyalar',null,20),
 ('ykb','world','World','https://www.worldcard.com.tr/kampanya',null,10),
 ('ykb','crystal','Crystal','https://www.crystalcard.com.tr/crystal-dunyasi/varliga-bagli-crystal-ayricaliklari/crystal-ile-yurt-disi-yurt-ici-tum-restoranlarda-5-indirim','2026-10-03T19:00:00Z',20),
 ('garanti','bonus-garanti','Bonus','https://www.bonus.com.tr/kampanyalar','2026-10-04T00:00:00Z',10),
 ('ziraat','bankkart','Bankkart','https://www.bankkart.com.tr/kampanyalar','2026-10-04T00:00:00Z',10),
 ('halkbank','paraf','Paraf','https://www.paraf.com.tr/tr/kampanyalar.html','2026-10-04T00:00:00Z',10),
 ('vakifbank','vakifkart','Vakıfkart (VakıfBank Worldcard)','https://www.vakifkart.com.tr/kampanyalar','2026-10-04T00:00:00Z',10)
) as v(bank_code,code,name,source_url,verified_at,sort_order)
join public.banks b on b.code=v.bank_code
on conflict (code) do update set bank_id=excluded.bank_id, name=excluded.name, source_url=excluded.source_url, verified_at=excluded.verified_at, sort_order=excluded.sort_order;

-- ---------- 3) Kart ürünü → program ----------
alter table public.card_products add column if not exists program_code text references public.card_programs(code) on delete set null;
update public.card_products p set program_code = v.program_code
from (values
 ('akbank-wings-elite','wings'),
 ('akbank-wings-black','wings'),
 ('is-maximiles-black','maximiles'),
 ('qnb-ms-private','miles-smiles-qnb'),
 ('teb-infinite',null),
 ('ykb-crystal','crystal')
) as v(code,program_code)
where p.code = v.code and p.program_code is distinct from v.program_code;

-- ---------- 4) Banka kapsamı ----------
create table if not exists public.bank_coverage (
  bank_id uuid primary key references public.banks(id) on delete cascade,
  card_products text not null check (card_products in ('full','partial','none')),
  profile_dimensions text not null check (profile_dimensions in ('full','partial','none')),
  core_benefits text not null check (core_benefits in ('full','partial','none')),
  campaigns text not null check (campaigns in ('full','partial','none','coming')),  -- ÜST SINIR; istemci kaynak kaydıyla kırpar
  note text,
  updated_at timestamptz not null default now()
);
insert into public.bank_coverage(bank_id,card_products,profile_dimensions,core_benefits,campaigns,note)
select b.id, v.card_products, v.profile_dimensions, v.core_benefits, v.campaigns, v.note
from (values
 ('akbank','partial','partial','partial','partial','Wings Elite/Black kapsanıyor; Axess ürünleri henüz yok.'),
 ('isbank','partial','partial','partial','partial','Maximiles Black kapsanıyor; Maximum ürünleri henüz yok.'),
 ('qnb','partial','partial','partial','partial','Miles&Smiles QNB Private kapsanıyor.'),
 ('teb','partial','partial','partial','partial','TEB Özel Infinite kapsanıyor.'),
 ('ykb','partial','partial','partial','partial','Crystal kapsanıyor; World ürünleri henüz yok.'),
 ('garanti','none','none','none','coming','Bonus programı kayıtlı; kart ürünleri ve kampanya tarayıcısı hazırlanıyor.'),
 ('ziraat','none','none','none','coming','Bankkart programı kayıtlı; kart ürünleri ve kampanya tarayıcısı hazırlanıyor.'),
 ('halkbank','none','none','none','coming','Paraf programı kayıtlı; kart ürünleri ve kampanya tarayıcısı hazırlanıyor.'),
 ('vakifbank','none','none','none','coming','Vakıfkart programı kayıtlı; kart ürünleri ve kampanya tarayıcısı hazırlanıyor.'),
 ('denizbank','none','none','none','none','Yalnız banka kaydı; program ve kampanya kaynağı henüz doğrulanmadı.')
) as v(bank_code,card_products,profile_dimensions,core_benefits,campaigns,note)
join public.banks b on b.code=v.bank_code
on conflict (bank_id) do update set card_products=excluded.card_products, profile_dimensions=excluded.profile_dimensions,
  core_benefits=excluded.core_benefits, campaigns=excluded.campaigns, note=excluded.note, updated_at=now();

-- ---------- 5) Wings / TEB görünen adları (kimlik ve engine_label aynı kalır) ----------
update public.profile_dimension_options o set label = v.label
from (values
 ('wings_tier','standard','Classic'),
 ('wings_tier','black','Black'),
 ('wings_tier','black_plus','Black Plus'),
 ('teb_tier','standard','Standart'),
 ('teb_tier','plus','Plus'),
 ('teb_tier','premium','Premium'),
 ('teb_tier','ultra','Ultra')
) as v(dimension_code,code,label)
where o.dimension_code = v.dimension_code and o.code = v.code and o.label is distinct from v.label;

-- ---------- 6) RLS + yetkiler (ana veri: oturum açmış okur; yazma yalnız service_role/migration) ----------
alter table public.card_programs enable row level security;
alter table public.bank_coverage enable row level security;
drop policy if exists "authenticated read card programs" on public.card_programs;
create policy "authenticated read card programs" on public.card_programs for select to authenticated using (true);
drop policy if exists "authenticated read bank coverage" on public.bank_coverage;
create policy "authenticated read bank coverage" on public.bank_coverage for select to authenticated using (true);
revoke all on table public.card_programs, public.bank_coverage from anon;
grant select on table public.card_programs, public.bank_coverage to authenticated;
grant all privileges on table public.card_programs, public.bank_coverage to service_role;

comment on table public.card_programs is 'Doğrulanmış kart programları/aileleri (global ana veri). web/profile-catalog.js PROFILE_CARD_PROGRAMS ile birebir.';
comment on table public.bank_coverage is 'Banka kapsam fasetleri (global). Genel destek düzeyi istemcide türetilir (web/coverage.js); etkin tarayıcısı olmayan banka kampanya kapsamı gösteremez.';

commit;
