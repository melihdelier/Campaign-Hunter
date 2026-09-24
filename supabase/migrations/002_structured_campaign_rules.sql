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
