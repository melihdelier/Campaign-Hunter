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
