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
