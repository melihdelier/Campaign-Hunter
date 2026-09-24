-- Banka Kampanya Avcisi v1.2.0 PWA - Supabase tek seferlik kurulum
-- YENI/BOS Supabase projesinde bir kez calistirin.
-- Kart numarasi, CVV, son kullanma tarihi veya banka giris bilgisi tutmaz.

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
