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
