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
