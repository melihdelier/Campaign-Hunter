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
