-- Banka Kampanya Avcisi - Supabase tek seferlik kurulum (YENI proje: 001-010). Mevcut projede yalniz eksik migrations dosyalarini (008, 009, 010) sirayla calistirin.
-- YENI/BOS Supabase projesinde bir kez calistirin.
-- Kart numarasi, CVV, son kullanma tarihi veya banka giris bilgisi tutmaz. Varlik TUTARI da tutmaz (yalniz bant secimi).

-- ============================================================
-- 001_init.sql
-- ============================================================
-- Banka Kampanya Avcısı v0.1
-- Supabase/PostgreSQL şeması
-- Güvenlik prensibi: kart numarası, CVV, son kullanma tarihi veya banka giriş bilgisi için alan YOKTUR.

create extension if not exists pgcrypto;

create type public.enrollment_status as enum ('unknown','not_required','joined','not_joined');
create type public.limit_value_source as enum ('user_confirmed','system_estimated','reset');
create type public.campaign_reset_policy as enum ('monthly','campaign','none');
create type public.campaign_source_kind as enum ('official_web','user_private','manual','demo');

create table public.banks (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.card_products (
  id uuid primary key default gen_random_uuid(),
  bank_id uuid not null references public.banks(id) on delete cascade,
  code text unique not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.user_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_product_id uuid not null references public.card_products(id),
  segment_label text,
  nickname text,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, card_product_id, segment_label)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  bank_id uuid not null references public.banks(id),
  title text not null,
  category text not null default 'all',
  source_kind public.campaign_source_kind not null default 'official_web',
  source_url text,
  external_key text,
  start_at timestamptz,
  end_at timestamptz,
  status text not null default 'active' check (status in ('draft','active','inactive','expired')),
  requires_enrollment boolean not null default false,
  enrollment_channel text,
  reset_policy public.campaign_reset_policy not null default 'campaign',
  period_cap numeric(14,2),
  per_transaction_cap numeric(14,2),
  merchant_scope jsonb not null default '{"kind":"all"}'::jsonb,
  reward_rule jsonb not null default '{}'::jsonb,
  terms_summary text,
  terms_raw text,
  source_last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(bank_id, external_key)
);

create table public.campaign_card_eligibility (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  card_product_id uuid not null references public.card_products(id) on delete cascade,
  segment_rule jsonb not null default '{}'::jsonb,
  primary key(campaign_id, card_product_id)
);

-- Kullanıcının kampanya bazındaki mevcut durumu.
-- remaining_limit bilinmiyorsa NULL bırakılır; uygulama kesin kazançmış gibi göstermez.
create table public.user_campaign_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  period_key text not null,
  enrollment_status public.enrollment_status not null default 'unknown',
  remaining_limit numeric(14,2),
  used_amount numeric(14,2),
  value_source public.limit_value_source not null default 'system_estimated',
  confirmed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, campaign_id, period_key)
);

-- Her manuel düzeltme/reset geçmişte kalır; sessizce veri kaybetmeyiz.
create table public.user_campaign_state_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  period_key text not null,
  event_type text not null check (event_type in ('manual_limit_update','automatic_reset','enrollment_change','system_estimate')),
  previous_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);

create table public.private_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bank_id uuid references public.banks(id),
  card_product_id uuid references public.card_products(id),
  title text not null,
  category text not null default 'all',
  start_at timestamptz,
  end_at timestamptz,
  requires_enrollment boolean not null default false,
  enrollment_channel text,
  reset_policy public.campaign_reset_policy not null default 'campaign',
  period_cap numeric(14,2),
  per_transaction_cap numeric(14,2),
  merchant_scope jsonb not null default '{"kind":"all"}'::jsonb,
  reward_rule jsonb not null default '{}'::jsonb,
  terms_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Public katalog tabloları authenticated kullanıcılarca okunabilir.
alter table public.banks enable row level security;
alter table public.card_products enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_card_eligibility enable row level security;
alter table public.user_cards enable row level security;
alter table public.user_campaign_state enable row level security;
alter table public.user_campaign_state_events enable row level security;
alter table public.private_campaigns enable row level security;

create policy "authenticated read banks" on public.banks for select to authenticated using (true);
create policy "authenticated read card products" on public.card_products for select to authenticated using (true);
create policy "authenticated read campaigns" on public.campaigns for select to authenticated using (true);
create policy "authenticated read eligibility" on public.campaign_card_eligibility for select to authenticated using (true);

create policy "users manage own cards" on public.user_cards for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage own campaign state" on public.user_campaign_state for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users read own campaign state events" on public.user_campaign_state_events for select to authenticated
  using (auth.uid() = user_id);
create policy "users insert own campaign state events" on public.user_campaign_state_events for insert to authenticated
  with check (auth.uid() = user_id);
create policy "users manage own private campaigns" on public.private_campaigns for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index idx_campaigns_active_dates on public.campaigns(status, start_at, end_at);
create index idx_campaigns_bank_category on public.campaigns(bank_id, category);
create index idx_user_state_user_campaign on public.user_campaign_state(user_id, campaign_id);
create index idx_user_cards_user on public.user_cards(user_id);

-- Banka ve kart ürün kataloğu
insert into public.banks(code,name) values
 ('qnb','QNB'),('akbank','Akbank'),('isbank','İş Bankası'),('ykb','Yapı Kredi'),('teb','TEB')
on conflict (code) do nothing;

insert into public.card_products(bank_id,code,name)
select b.id, v.code, v.name
from (values
 ('qnb','qnb-ms-private','Miles&Smiles QNB Private'),
 ('akbank','akbank-wings-elite','Wings Elite'),
 ('akbank','akbank-wings-black','Wings Black'),
 ('isbank','is-maximiles-black','Maximiles Black'),
 ('ykb','ykb-crystal','Crystal'),
 ('teb','teb-infinite','TEB Özel Infinite')
) as v(bank_code,code,name)
join public.banks b on b.code=v.bank_code
on conflict (code) do nothing;

-- ============================================================
-- 002_structured_campaign_rules.sql
-- ============================================================
-- v0.2: Kampanya başlığı tek başına karar motoruna giremez.
-- Detay sayfasından yapılandırılmış kurallar ve doğrulama durumu tutulur.

alter table public.campaigns
  add column if not exists categories text[] not null default array['all']::text[],
  add column if not exists transaction_rules jsonb not null default '{}'::jsonb,
  add column if not exists decision_warnings jsonb not null default '[]'::jsonb,
  add column if not exists rules_complete boolean not null default false,
  add column if not exists rules_verified_at timestamptz;

comment on column public.campaigns.reward_rule is
'Alt/üst harcama eşiği, oran, tier ve işlem başı tavan dahil hesaplanabilir kazanç kuralı.';
comment on column public.campaigns.transaction_rules is
'Yurt içi/yurt dışı, ödeme kanalı, POS şartı, hariç işlemler, aynı gün ilk işlem gibi detay koşulları.';
comment on column public.campaigns.rules_complete is
'False ise kampanya karar motorunda kesin öneri olarak gösterilmemelidir.';
comment on column public.campaign_card_eligibility.segment_rule is
'Kart ürününe ek olarak varlık/müşteri segmenti ve gerekiyorsa diğer uygunluk koşulları.';

-- ============================================================
-- 003_potential_campaign_progress.sql
-- ============================================================
-- v0.3: Bazı kampanyalarda ödül yalnızca 2. veya sonraki uygun işlemden itibaren başlar.
-- Kullanıcı tüm harcamaları sisteme girmek zorunda olmadığı için ilerleme NULL olabilir ve manuel doğrulanabilir.

alter table public.user_campaign_state
  add column if not exists qualifying_transaction_count integer;

alter table public.user_campaign_state
  add constraint user_campaign_state_qualifying_transaction_count_nonnegative
  check (qualifying_transaction_count is null or qualifying_transaction_count >= 0);

comment on column public.user_campaign_state.qualifying_transaction_count is
'Kampanya dönemindeki kullanıcı tarafından doğrulanmış uygun işlem adedi. NULL = bilinmiyor; karar motoru kesin ödül varsaymaz.';

-- ============================================================
-- 004_reward_profile.sql
-- ============================================================
-- v0.6: Kullanıcının kart sadakat/kazanım profili.
-- Hassas kart verisi içermez; yalnızca program/statü seçimleri tutulur.
create table if not exists public.user_reward_profile (
  user_id uuid primary key references auth.users(id) on delete cascade,
  thy_status text not null default 'classic' check (thy_status in ('classic','classic_plus','elite','elite_plus')),
  wings_tier text not null default 'black_plus' check (wings_tier in ('standard','black','black_plus')),
  maximiles_band text not null default '4m_8m' check (maximiles_band in ('under_1m','1m_4m','4m_8m','8m_plus')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_reward_profile enable row level security;
create policy "users manage own reward profile" on public.user_reward_profile for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on table public.user_reward_profile is
'Kart numarası içermez. Yalnızca THY statüsü ve banka sadakat/varlık programı seçimlerini tutar.';

-- ============================================================
-- 005_all_segment_profiles.sql
-- ============================================================
-- v1.0.4: Tüm banka/kart segment seçimleri kullanıcı tarafından değiştirilebilir.
-- Hassas kart verisi içermez; yalnızca müşteri/varlık segmenti ve kart ürün varyantı tutulur.
alter table public.user_reward_profile
  add column if not exists qnb_segment text not null default 'private',
  add column if not exists crystal_band text not null default 'under_1m',
  add column if not exists crystal_card_type text not null default 'crystal',
  add column if not exists teb_tier text not null default 'ultra';

alter table public.user_reward_profile
  drop constraint if exists user_reward_profile_qnb_segment_check,
  add constraint user_reward_profile_qnb_segment_check
    check (qnb_segment in ('other','first','first_plus','private')),
  drop constraint if exists user_reward_profile_crystal_band_check,
  add constraint user_reward_profile_crystal_band_check
    check (crystal_band in ('under_1m','1m_6m','6m_10m','10m_plus')),
  drop constraint if exists user_reward_profile_crystal_card_type_check,
  add constraint user_reward_profile_crystal_card_type_check
    check (crystal_card_type in ('crystal','metal_crystal')),
  drop constraint if exists user_reward_profile_teb_tier_check,
  add constraint user_reward_profile_teb_tier_check
    check (teb_tier in ('standard','plus','premium','ultra'));

comment on table public.user_reward_profile is
'Kart numarası içermez. THY statüsü ile QNB, Wings, Maximiles Black, Crystal ve TEB Infinite segment/paket seçimlerini tutar.';

-- ============================================================
-- 006_pwa_cloud.sql
-- ============================================================
-- v1.2.0 PWA bulut katmanı.
-- Kart numarası, CVV, son kullanma tarihi veya banka giriş bilgisi tutulmaz.

create table if not exists public.catalog_snapshots (
  id integer primary key check (id = 1),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.catalog_snapshots enable row level security;

drop policy if exists "public read active catalog snapshot" on public.catalog_snapshots;
create policy "public read active catalog snapshot"
  on public.catalog_snapshots for select
  to anon, authenticated
  using (id = 1);

create table if not exists public.user_app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  campaign_states jsonb not null default '{}'::jsonb,
  private_campaigns jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_app_state enable row level security;

drop policy if exists "users read own app state" on public.user_app_state;
create policy "users read own app state" on public.user_app_state for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users insert own app state" on public.user_app_state;
create policy "users insert own app state" on public.user_app_state for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "users update own app state" on public.user_app_state;
create policy "users update own app state" on public.user_app_state for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on table public.user_app_state is
'PWA cihazlar arası senkron için profil, kampanya limit/katılım durumu ve kullanıcıya özel kampanyaları tutar. Hassas kart/banka giriş verisi içermez.';

-- ============================================================
-- 007_explicit_data_api_grants.sql
-- Supabase 2026: "Automatically expose new tables" kapali oldugu icin
-- Data API erisimlerini en az yetki prensibiyle acikca tanimliyoruz.
-- RLS politikalari yukarida etkin; GRANT sadece tabloyu API'ye erisilebilir yapar.
-- ============================================================

-- Ortak katalog tablolarini yalniz oturum acmis kullanicilar okuyabilir.
grant select on table
  public.banks,
  public.card_products,
  public.campaigns,
  public.campaign_card_eligibility
  to authenticated;

-- Kullaniciya ait tablolar: RLS sayesinde herkes yalniz kendi satirina erisir.
grant select, insert, update, delete on table
  public.user_cards,
  public.user_campaign_state,
  public.private_campaigns,
  public.user_reward_profile,
  public.user_app_state
  to authenticated;

grant select, insert on table
  public.user_campaign_state_events
  to authenticated;

-- PWA katalog snapshot'i giris yapmadan da okunabilir.
grant select on table public.catalog_snapshots to anon, authenticated;

-- Sunucu/crawler tarafindaki secret key service_role olarak calisir.
-- Yalniz backend'de kullanilir; PWA'ya konmaz.
grant all privileges on table
  public.banks,
  public.card_products,
  public.campaigns,
  public.campaign_card_eligibility,
  public.user_cards,
  public.user_campaign_state,
  public.user_campaign_state_events,
  public.private_campaigns,
  public.user_reward_profile,
  public.catalog_snapshots,
  public.user_app_state
  to service_role;

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

-- ============================================================
-- 009_eligibility_only_dimensions.sql  (Campaign Hunter v1.4.1)
-- Profil boyutu yalnız kampanya uygunluğu için var olabilir (karar motorunun ödül/segment alanına bağlı olmadan).
-- engine_binding değer kümesine 'eligibility_only' eklenir. Mevcut satırlar ve davranış DEĞİŞMEZ.
-- Tek transaction, tekrar çalıştırılabilir; veri silmez.
-- ============================================================
begin;

alter table public.profile_dimensions drop constraint if exists profile_dimensions_engine_binding_check;
alter table public.profile_dimensions add constraint profile_dimensions_engine_binding_check
  check (engine_binding in ('card_segment','card_type','loyalty','eligibility_only'));

comment on column public.profile_dimensions.engine_binding is
'card_segment: seçenek engine_label''ı kapsamdaki kartların segment alanına (geriye uyumluluk); card_type: kart tipi; loyalty: yalnız normal kazanım; eligibility_only: yalnız kampanya uygunluk kuralları. Uygunluk her durumda öznitelikleri boyut/seçenek koduyla okur.';

commit;

-- ============================================================
-- 010_option_criteria.sql  (Campaign Hunter v1.4.3)
-- Seçenek KİMLİĞİ ile seçenek ÖLÇÜTÜ ayrılır.
--  1) Maximiles / Crystal varlık bantlarının eşik içeren eski seçenek kodları nötr, boyuta özel kodlara çevrilir
--     (band_1 …). maximiles_band.band_2 ile crystal_band.band_2 aynı tutar aralığı DEĞİLDİR.
--  2) public.profile_option_criteria: insan-okur etiket, TL sınırları, kaynak, doğrulama zamanı ve geçerlilik
--     tarihleri SÜRÜMLÜ tutulur. Banka eşiği değişirse yeni criteria_version eklenir, eskisine effective_to yazılır.
--  3) user_profile_attributes: seçimin hangi ölçüt sürümünde onaylandığı (criteria_version) ve ne zaman (confirmed_at).
--     Ölçüt değişince eski onay sessizce güncel kabul edilmez; istemci yeniden onay ister.
-- Kullanıcının varlık TUTARI istenmez ve saklanmaz; yalnız bant seçimi saklanır.
-- Tek transaction, tekrar çalıştırılabilir, kullanıcı seçimi kaybolmaz. Ölçüt seed'i ON CONFLICT DO UPDATE ile yazılır:
-- 010'un önceki bir sürümünü çalıştırmış veritabanında güncel 010'u yeniden çalıştırmak kaynak/doğrulama bilgisini düzeltir.
-- ============================================================
begin;

-- ---------- 1) Nötr bant seçenekleri (008'in güncel seed'i ile aynı) ----------
insert into public.profile_dimension_options(dimension_code,code,label,engine_label,sort_order) values
 ('maximiles_band','band_1','1. bant','band_1',10),
 ('maximiles_band','band_2','2. bant','band_2',20),
 ('maximiles_band','band_3','3. bant','band_3',30),
 ('maximiles_band','band_4','4. bant','band_4',40),
 ('crystal_band','band_1','1. bant','band_1',10),
 ('crystal_band','band_2','2. bant','band_2',20),
 ('crystal_band','band_3','3. bant','band_3',30),
 ('crystal_band','band_4','4. bant','band_4',40)
on conflict (dimension_code,code) do update set label=excluded.label, engine_label=excluded.engine_label, sort_order=excluded.sort_order;

-- ---------- 2) Ölçüt tablosu (global ana veri) ----------
create table if not exists public.profile_option_criteria (
  dimension_code text not null,
  option_code text not null,
  criteria_version text not null check (criteria_version ~ '^[a-z0-9][a-z0-9_.-]*$'),
  effective_from date not null,                       -- bu tanımın uygulandığı bilinen ilk gün (Europe/Istanbul)
  effective_to date,                                  -- dışlayıcı; null = yürürlükte
  display_label text not null,
  lower_bound numeric(16,2),                          -- TL, bilgi amaçlı (dahil/hariç yorumu source_reference'taki ifadeye göre)
  upper_bound numeric(16,2),
  bound_unit text not null default 'TRY',
  source_url text not null check (source_url ~ '^https://'),
  source_reference text,
  verified_at timestamptz,                            -- KAYNAK doğrulaması (global ana veri tazeliği); null = doğrulanamadı.
                                                      -- Kullanıcının kendi seçim onayından (user_profile_attributes.criteria_version/confirmed_at) AYRIDIR.
  created_at timestamptz not null default now(),
  primary key (dimension_code, option_code, criteria_version),
  foreign key (dimension_code, option_code) references public.profile_dimension_options(dimension_code, code) on delete cascade,
  check (effective_to is null or effective_to > effective_from),
  check (lower_bound is null or upper_bound is null or upper_bound > lower_bound)
);
create index if not exists idx_profile_option_criteria_dim_version on public.profile_option_criteria(dimension_code, criteria_version);
comment on table public.profile_option_criteria is
'Seçenek ölçütleri (etiket, sınırlar, kaynak, doğrulama, geçerlilik). Seçenek kodu kimliktir ve eşik içermez; eşik değişince yeni criteria_version eklenir. web/profile-catalog.js PROFILE_OPTION_CRITERIA ile birebir.';

alter table public.profile_option_criteria enable row level security;
drop policy if exists "authenticated read profile option criteria" on public.profile_option_criteria;
create policy "authenticated read profile option criteria" on public.profile_option_criteria for select to authenticated using (true);
revoke all on table public.profile_option_criteria from anon;
grant select on table public.profile_option_criteria to authenticated;
grant all privileges on table public.profile_option_criteria to service_role;

insert into public.profile_option_criteria(dimension_code,option_code,criteria_version,effective_from,effective_to,display_label,lower_bound,upper_bound,bound_unit,source_url,source_reference,verified_at) values
 ('maximiles_band','band_1','v1','2026-10-01',null,'1 milyon TL''ye kadar',null,1000000,'TRY','https://www.maximiles.com.tr/kampanyalar/maximiles-black-ile-restoranlarda-20-indirim-ayricaligi','Maximiles Black restoran kampanyası 01.10.2026–31.12.2026: "Bankamızda 1.000.000 TL''ye kadar varlık birikimi olan müşterilerimiz"','2026-10-03T00:00:00Z'),
 ('maximiles_band','band_2','v1','2026-10-01',null,'1–4 milyon TL arası',1000000,4000000,'TRY','https://www.maximiles.com.tr/kampanyalar/maximiles-black-ile-restoranlarda-20-indirim-ayricaligi','Maximiles Black restoran kampanyası 01.10.2026–31.12.2026: "Bankamızda 1.000.000 TL-4.000.000 TL arası varlık birikimi olan müşterilerimiz"','2026-10-03T00:00:00Z'),
 ('maximiles_band','band_3','v1','2026-10-01',null,'4–8 milyon TL arası',4000000,8000000,'TRY','https://www.maximiles.com.tr/kampanyalar/maximiles-black-ile-restoranlarda-20-indirim-ayricaligi','Maximiles Black restoran kampanyası 01.10.2026–31.12.2026: "Bankamızda 4.000.000 TL-8.000.000 TL arası varlık birikimi olan müşterilerimiz"','2026-10-03T00:00:00Z'),
 ('maximiles_band','band_4','v1','2026-10-01',null,'8 milyon TL üzeri',8000000,null,'TRY','https://www.maximiles.com.tr/kampanyalar/maximiles-black-ile-restoranlarda-20-indirim-ayricaligi','Maximiles Black restoran kampanyası 01.10.2026–31.12.2026: "Bankamızda 8.000.000 TL üzeri varlık birikimi olan müşterilerimiz"','2026-10-03T00:00:00Z'),
 ('crystal_band','band_1','v1','2026-10-01',null,'1 milyon TL altı',null,1000000,'TRY','https://www.crystalcard.com.tr/crystal-dunyasi/varliga-bagli-crystal-ayricaliklari/crystal-ile-yurt-disi-yurt-ici-tum-restoranlarda-5-indirim','Crystal Card resmi sayfası, Varlığa Bağlı Crystal Ayrıcalıkları (anlaşmalı otel/restoran %20): "Toplam varlığı 1 milyon TL''nin altında olan müşterilerimiz, işlem bazında en fazla 1.500 TL, aylık bazda en fazla 3.000 TL indirim kazanabilir."','2026-10-03T19:00:00Z'),
 ('crystal_band','band_2','v1','2026-10-01',null,'1–6 milyon TL',1000000,6000000,'TRY','https://www.crystalcard.com.tr/crystal-dunyasi/varliga-bagli-crystal-ayricaliklari/crystal-ile-yurt-disi-yurt-ici-tum-restoranlarda-5-indirim','Crystal Card resmi sayfası, Varlığa Bağlı Crystal Ayrıcalıkları (anlaşmalı otel/restoran %20): "Toplam varlığı 1 milyon TL - 6 milyon TL arasında olan müşterilerimiz, işlem bazında en fazla 2.500 TL, aylık bazda en fazla 5.000 TL indirim kazanabilir."','2026-10-03T19:00:00Z'),
 ('crystal_band','band_3','v1','2026-10-01',null,'6–10 milyon TL',6000000,10000000,'TRY','https://www.crystalcard.com.tr/crystal-dunyasi/varliga-bagli-crystal-ayricaliklari/crystal-ile-yurt-disi-yurt-ici-tum-restoranlarda-5-indirim','Crystal Card resmi sayfası, Varlığa Bağlı Crystal Ayrıcalıkları (anlaşmalı otel/restoran %20): "Toplam varlığı 6 milyon TL - 10 milyon TL arasında olan müşterilerimiz, işlem bazında en fazla 3.000 TL, aylık bazda en fazla 7.500 TL indirim kazanabilir."','2026-10-03T19:00:00Z'),
 ('crystal_band','band_4','v1','2026-10-01',null,'10 milyon TL ve üzeri',10000000,null,'TRY','https://www.crystalcard.com.tr/crystal-dunyasi/varliga-bagli-crystal-ayricaliklari/crystal-ile-yurt-disi-yurt-ici-tum-restoranlarda-5-indirim','Crystal Card resmi sayfası, Varlığa Bağlı Crystal Ayrıcalıkları (anlaşmalı otel/restoran %20): "Toplam varlığı 10 milyon TL ve üzerinde olan Crystal kart sahibi müşterilerimiz, işlem bazında en fazla 4.000 TL, aylık bazda en fazla 10.000 TL değerinde indirim kazanabilir."','2026-10-03T19:00:00Z')
on conflict (dimension_code,option_code,criteria_version) do update set
  effective_from=excluded.effective_from, effective_to=excluded.effective_to, display_label=excluded.display_label,
  lower_bound=excluded.lower_bound, upper_bound=excluded.upper_bound, bound_unit=excluded.bound_unit,
  source_url=excluded.source_url, source_reference=excluded.source_reference, verified_at=excluded.verified_at;

-- ---------- 3) Kullanıcı seçiminin onay bilgisi ----------
alter table public.user_profile_attributes
  add column if not exists criteria_version text,
  add column if not exists confirmed_at timestamptz;
alter table public.user_profile_attributes drop constraint if exists user_profile_attributes_criteria_fk;
alter table public.user_profile_attributes add constraint user_profile_attributes_criteria_fk
  foreign key (dimension_code, option_code, criteria_version)
  references public.profile_option_criteria(dimension_code, option_code, criteria_version);  -- null sürüm = onay bilgisi yok
comment on column public.user_profile_attributes.criteria_version is 'Seçimin onaylandığı ölçüt sürümü (profile_option_criteria). Güncel sürümden farklıysa istemci yeniden onay ister; null = bilinmiyor.';
comment on column public.user_profile_attributes.confirmed_at is 'Kullanıcının bu seçimi en son onayladığı zaman.';

-- ---------- 4) Eski (eşik kodlu) seçimlerin dönüştürülmesi ----------
-- 008'in eski seed'iyle kurulmuş veritabanları. Eski seçim, ölçüt v1 ile AYNI eşikleri gösteren etiketlerle
-- yapılmıştı; bu yüzden v1 altında onaylanmış sayılır (confirmed_at = son güncelleme zamanı).
create temporary table ch_band_code_map(dimension_code text, old_code text, new_code text) on commit drop;
insert into ch_band_code_map values
 ('maximiles_band','under_1m','band_1'),('maximiles_band','1m_4m','band_2'),('maximiles_band','4m_8m','band_3'),('maximiles_band','8m_plus','band_4'),
 ('crystal_band','under_1m','band_1'),('crystal_band','1m_6m','band_2'),('crystal_band','6m_10m','band_3'),('crystal_band','10m_plus','band_4');

update public.user_profile_attributes a
   set option_code = m.new_code,
       criteria_version = coalesce(a.criteria_version, 'v1'),
       confirmed_at = coalesce(a.confirmed_at, a.updated_at)
  from ch_band_code_map m
 where a.dimension_code = m.dimension_code and a.option_code = m.old_code;

delete from public.profile_dimension_options o
 using ch_band_code_map m
 where o.dimension_code = m.dimension_code and o.code = m.old_code;

-- Kullanımdan kalkmış eski tablo (v1.4'ten beri okunmuyor; veri korunur): değerler ve kısıtlar da nötr kodlara.
do $$
begin
  if to_regclass('public.user_reward_profile') is not null then
    alter table public.user_reward_profile drop constraint if exists user_reward_profile_maximiles_band_check;
    alter table public.user_reward_profile drop constraint if exists user_reward_profile_crystal_band_check;
    update public.user_reward_profile r set maximiles_band = m.new_code from ch_band_code_map m
     where m.dimension_code = 'maximiles_band' and r.maximiles_band = m.old_code;
    update public.user_reward_profile r set crystal_band = m.new_code from ch_band_code_map m
     where m.dimension_code = 'crystal_band' and r.crystal_band = m.old_code;
    alter table public.user_reward_profile alter column maximiles_band set default 'band_3';
    alter table public.user_reward_profile alter column crystal_band set default 'band_1';
    alter table public.user_reward_profile add constraint user_reward_profile_maximiles_band_check
      check (maximiles_band in ('band_1','band_2','band_3','band_4'));
    alter table public.user_reward_profile add constraint user_reward_profile_crystal_band_check
      check (crystal_band in ('band_1','band_2','band_3','band_4'));
  end if;
end $$;

commit;
