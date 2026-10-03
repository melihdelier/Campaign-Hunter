-- ============================================================
-- 008_user_profiles.sql  (Campaign Hunter v1.4.0)
-- Hesaba bağlı kişisel profil: bankalar, kartlar, segment/statü öznitelikleri, tercihler, onboarding durumu.
-- EK (additive) ve TEKRAR ÇALIŞTIRILABİLİR: mevcut tablo/veri silinmez; yalnız yeni kolon/tablo/politika eklenir.
-- Kart numarası, CVV, son kullanma tarihi, banka şifresi/oturum bilgisi için alan YOKTUR.
--
-- Ana veri (global, salt-okunur):  banks, card_products, profile_dimensions, profile_dimension_options, profile_dimension_cards
-- Kullanıcı verisi (RLS: auth.uid() = user_id):  profiles, user_banks, user_cards (mevcut), user_profile_attributes, user_preferences
-- Tek transaction: herhangi bir adım başarısız olursa hiçbir değişiklik kalmaz.
-- ============================================================
begin;

-- ---------- 1) Ana veri: banka / kart ürünü kolonları ----------
alter table public.banks
  add column if not exists active boolean not null default true,
  add column if not exists sort_order integer not null default 100;

alter table public.card_products
  add column if not exists family text,
  add column if not exists sort_order integer not null default 100,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- ---------- 2) Ana veri: genel profil boyutları (segment, varlık bandı, sadakat statüsü, kart varyantı ...) ----------
-- Yeni bir banka segmenti eklemek = buraya satır eklemek; şema/uygulama mimarisi değişmez.
create table if not exists public.profile_dimensions (
  code text primary key check (code ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  kind text not null check (kind in ('segment','asset_band','loyalty_status','card_variant','other')),
  bank_id uuid references public.banks(id) on delete cascade,          -- null = bankadan bağımsız program (ör. THY)
  engine_binding text not null default 'card_segment' check (engine_binding in ('card_segment','card_type','loyalty')),
  setting_key text,                                                     -- mevcut kazanım formülleri için ayar anahtarı
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Boyutun hangi kart ürünleri için geçerli olduğu (kullanıcı bu kartlardan birine sahipse sorulur).
create table if not exists public.profile_dimension_cards (
  dimension_code text not null references public.profile_dimensions(code) on delete cascade,
  card_product_id uuid not null references public.card_products(id) on delete cascade,
  primary key (dimension_code, card_product_id)
);
create index if not exists idx_profile_dimension_cards_card on public.profile_dimension_cards(card_product_id);

create table if not exists public.profile_dimension_options (
  dimension_code text not null references public.profile_dimensions(code) on delete cascade,
  code text not null check (code ~ '^[a-z0-9_]+$'),
  label text not null,
  engine_label text,                                                    -- karar motorundaki segment etiketi
  sort_order integer not null default 100,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  primary key (dimension_code, code)
);

-- ---------- 3) Kullanıcı verisi ----------
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 80),
  onboarding_completed_at timestamptz,
  profile_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_banks (
  user_id uuid not null references auth.users(id) on delete cascade,
  bank_id uuid not null references public.banks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, bank_id)
);
create index if not exists idx_user_banks_bank on public.user_banks(bank_id);

-- user_cards (001) yeniden kullanılır. segment_label artık kullanılmaz (segmentler user_profile_attributes'ta).
-- Kullanıcı başına kart ürünü tekil olmalı. Var olan çift kayıt varsa veri SİLİNMEZ; migration açık hata ile durur.
do $$
begin
  if exists (select 1 from public.user_cards group by user_id, card_product_id having count(*) > 1) then
    raise exception 'user_cards contains duplicate (user_id, card_product_id) rows; resolve them before applying 008 (no data was changed)';
  end if;
end $$;
create unique index if not exists user_cards_user_product_uidx on public.user_cards(user_id, card_product_id);
comment on column public.user_cards.segment_label is 'DEPRECATED (v1.4): segmentler public.user_profile_attributes tablosunda tutulur.';

create table if not exists public.user_profile_attributes (
  user_id uuid not null references auth.users(id) on delete cascade,
  dimension_code text not null,
  option_code text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, dimension_code),
  foreign key (dimension_code, option_code) references public.profile_dimension_options(dimension_code, code) on delete cascade
);

create table if not exists public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.user_reward_profile is 'DEPRECATED (v1.4): profile_dimensions + user_profile_attributes kullanılır. Veri korunur, uygulama okumaz/yazmaz.';

-- ---------- 4) Bütünlük tetikleyicileri (SECURITY INVOKER: kullanıcının kendi RLS yetkisiyle çalışır) ----------
-- Kart yalnız kullanıcının seçtiği bankaya aitse eklenebilir.
create or replace function public.ch_user_cards_require_bank() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if not exists (
    select 1 from public.user_banks ub join public.card_products cp on cp.bank_id = ub.bank_id
    where ub.user_id = new.user_id and cp.id = new.card_product_id
  ) then
    raise exception 'card product % requires its bank to be selected first', new.card_product_id using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_user_cards_require_bank on public.user_cards;
create trigger trg_user_cards_require_bank before insert or update of card_product_id, user_id on public.user_cards
  for each row execute function public.ch_user_cards_require_bank();

-- Banka kaldırılınca o bankanın kartları ve bankaya bağlı profil öznitelikleri de kaldırılır.
create or replace function public.ch_user_banks_cascade() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  delete from public.user_cards uc using public.card_products cp
   where uc.user_id = old.user_id and uc.card_product_id = cp.id and cp.bank_id = old.bank_id;
  delete from public.user_profile_attributes a using public.profile_dimensions d
   where a.user_id = old.user_id and a.dimension_code = d.code and d.bank_id = old.bank_id;
  return old;
end $$;
drop trigger if exists trg_user_banks_cascade on public.user_banks;
create trigger trg_user_banks_cascade after delete on public.user_banks
  for each row execute function public.ch_user_banks_cascade();

create or replace function public.ch_touch_updated_at() returns trigger
language plpgsql security invoker set search_path = public as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles for each row execute function public.ch_touch_updated_at();
drop trigger if exists trg_user_preferences_touch on public.user_preferences;
create trigger trg_user_preferences_touch before update on public.user_preferences for each row execute function public.ch_touch_updated_at();
drop trigger if exists trg_user_profile_attributes_touch on public.user_profile_attributes;
create trigger trg_user_profile_attributes_touch before update on public.user_profile_attributes for each row execute function public.ch_touch_updated_at();

-- ---------- 5) RLS ----------
alter table public.profile_dimensions enable row level security;
alter table public.profile_dimension_cards enable row level security;
alter table public.profile_dimension_options enable row level security;
alter table public.profiles enable row level security;
alter table public.user_banks enable row level security;
alter table public.user_cards enable row level security;
alter table public.user_profile_attributes enable row level security;
alter table public.user_preferences enable row level security;

-- Ana veri: oturum açmış kullanıcılar okur; yazma yalnız service_role/migration.
drop policy if exists "authenticated read profile dimensions" on public.profile_dimensions;
create policy "authenticated read profile dimensions" on public.profile_dimensions for select to authenticated using (true);
drop policy if exists "authenticated read profile dimension cards" on public.profile_dimension_cards;
create policy "authenticated read profile dimension cards" on public.profile_dimension_cards for select to authenticated using (true);
drop policy if exists "authenticated read profile dimension options" on public.profile_dimension_options;
create policy "authenticated read profile dimension options" on public.profile_dimension_options for select to authenticated using (true);

-- Kullanıcı verisi: her işlem için ayrı, sahiplik = (select auth.uid()) = user_id
do $$
declare t text;
begin
  foreach t in array array['profiles','user_banks','user_profile_attributes','user_preferences'] loop
    execute format('drop policy if exists "own rows select" on public.%I', t);
    execute format('drop policy if exists "own rows insert" on public.%I', t);
    execute format('drop policy if exists "own rows update" on public.%I', t);
    execute format('drop policy if exists "own rows delete" on public.%I', t);
    execute format('create policy "own rows select" on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t);
    execute format('create policy "own rows insert" on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "own rows update" on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "own rows delete" on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', t);
  end loop;
end $$;
-- user_cards: 001'deki "users manage own cards" (for all, using+with check auth.uid() = user_id) korunur.

-- ---------- 6) Yetkiler (Data API) ----------
revoke all on table public.profiles, public.user_banks, public.user_profile_attributes, public.user_preferences,
  public.profile_dimensions, public.profile_dimension_cards, public.profile_dimension_options from anon;
grant select on table public.profile_dimensions, public.profile_dimension_cards, public.profile_dimension_options to authenticated;
grant select, insert, update, delete on table public.profiles, public.user_banks, public.user_profile_attributes, public.user_preferences to authenticated;
grant all privileges on table public.profile_dimensions, public.profile_dimension_cards, public.profile_dimension_options,
  public.profiles, public.user_banks, public.user_profile_attributes, public.user_preferences to service_role;

-- ---------- 7) Ana veri seed'i (web/profile-catalog.js ile birebir; test düzeneği doğrular) ----------
-- v1.4.3: varlık bantları nötr, boyuta özel kodlarla (band_N). Etiket/eşikler tarihli ölçüt tablosundadır (migration 010).
-- 008'i eski (eşik kodlu) seed ile zaten çalıştırmış veritabanları 010 ile dönüştürülür.
insert into public.banks(code,name,sort_order) values
 ('akbank','Akbank',10),
 ('isbank','İş Bankası',20),
 ('qnb','QNB',30),
 ('teb','TEB',40),
 ('ykb','Yapı Kredi',50)
on conflict (code) do update set name=excluded.name, sort_order=excluded.sort_order;

insert into public.card_products(bank_id,code,name,family,sort_order)
select b.id, v.code, v.name, v.family, v.sort_order
from (values
 ('akbank','akbank-wings-elite','Wings Elite','wings',10),
 ('akbank','akbank-wings-black','Wings Black','wings',20),
 ('isbank','is-maximiles-black','Maximiles Black','maximiles',10),
 ('qnb','qnb-ms-private','Miles&Smiles QNB Private','miles-smiles-qnb',10),
 ('teb','teb-infinite','TEB Özel Infinite','teb-infinite',10),
 ('ykb','ykb-crystal','Crystal','crystal',10)
) as v(bank_code,code,name,family,sort_order)
join public.banks b on b.code=v.bank_code
on conflict (code) do update set name=excluded.name, family=excluded.family, sort_order=excluded.sort_order, bank_id=excluded.bank_id;

insert into public.profile_dimensions(code,label,kind,bank_id,engine_binding,setting_key,sort_order)
select v.code, v.label, v.kind, b.id, v.engine_binding, v.setting_key, v.sort_order
from (values
 ('qnb_segment','QNB müşteri segmenti','segment','qnb','card_segment','qnbSegment',10),
 ('thy_status','Turkish Airlines Miles&Smiles statüsü','loyalty_status',null,'loyalty','thyStatus',15),
 ('wings_tier','Akbank Wings varlık programı','asset_band','akbank','card_segment','wingsTier',20),
 ('maximiles_band','Maximiles Black varlık bandı','asset_band','isbank','card_segment','maximilesBand',30),
 ('crystal_band','Yapı Kredi Crystal varlık bandı','asset_band','ykb','card_segment','crystalBand',40),
 ('crystal_card_type','Yapı Kredi Crystal kart tipi','card_variant','ykb','card_type','crystalCardType',45),
 ('teb_tier','TEB Infinite paket seviyesi','segment','teb','card_segment','tebTier',50)
) as v(code,label,kind,bank_code,engine_binding,setting_key,sort_order)
left join public.banks b on b.code=v.bank_code
on conflict (code) do update set label=excluded.label, kind=excluded.kind, bank_id=excluded.bank_id, engine_binding=excluded.engine_binding, setting_key=excluded.setting_key, sort_order=excluded.sort_order;

insert into public.profile_dimension_cards(dimension_code,card_product_id)
select v.dimension_code, p.id
from (values
 ('qnb_segment','qnb-ms-private'),
 ('thy_status','qnb-ms-private'),
 ('wings_tier','akbank-wings-elite'),
 ('wings_tier','akbank-wings-black'),
 ('maximiles_band','is-maximiles-black'),
 ('crystal_band','ykb-crystal'),
 ('crystal_card_type','ykb-crystal'),
 ('teb_tier','teb-infinite')
) as v(dimension_code,card_code)
join public.card_products p on p.code=v.card_code
on conflict do nothing;

insert into public.profile_dimension_options(dimension_code,code,label,engine_label,sort_order) values
 ('qnb_segment','other','Diğer / QNB First altı','Diğer',10),
 ('qnb_segment','first','QNB First','QNB First',20),
 ('qnb_segment','first_plus','QNB First Plus','QNB First Plus',30),
 ('qnb_segment','private','QNB Private','Private',40),
 ('thy_status','classic','Classic','Classic',10),
 ('thy_status','classic_plus','Classic Plus','Classic Plus',20),
 ('thy_status','elite','Elite','Elite',30),
 ('thy_status','elite_plus','Elite Plus','Elite Plus',40),
 ('wings_tier','standard','Classic / 1 milyon TL altı','Classic / 1 milyon TL altı',10),
 ('wings_tier','black','Black / 1–2 milyon TL','Black / 1–2 milyon TL',20),
 ('wings_tier','black_plus','Black Plus / 2 milyon TL+','Black Plus / 2 milyon TL+',30),
 ('maximiles_band','band_1','1. bant','band_1',10),
 ('maximiles_band','band_2','2. bant','band_2',20),
 ('maximiles_band','band_3','3. bant','band_3',30),
 ('maximiles_band','band_4','4. bant','band_4',40),
 ('crystal_band','band_1','1. bant','band_1',10),
 ('crystal_band','band_2','2. bant','band_2',20),
 ('crystal_band','band_3','3. bant','band_3',30),
 ('crystal_band','band_4','4. bant','band_4',40),
 ('crystal_card_type','crystal','Crystal','crystal',10),
 ('crystal_card_type','metal_crystal','Metal Crystal','metal_crystal',20),
 ('crystal_card_type','crystal_and_metal','Crystal + Metal Crystal (ikisi birden)','crystal_and_metal',30),
 ('teb_tier','standard','Standart / 1 milyon TL''ye kadar','Standart',10),
 ('teb_tier','plus','Plus / 1–5 milyon TL','Plus',20),
 ('teb_tier','premium','Premium / 5–10 milyon TL','Premium',30),
 ('teb_tier','ultra','Ultra / 10 milyon TL+','Ultra',40)
on conflict (dimension_code,code) do update set label=excluded.label, engine_label=excluded.engine_label, sort_order=excluded.sort_order;

commit;
