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
