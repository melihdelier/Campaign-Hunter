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
