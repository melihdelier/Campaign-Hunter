-- v0.3: Bazı kampanyalarda ödül yalnızca 2. veya sonraki uygun işlemden itibaren başlar.
-- Kullanıcı tüm harcamaları sisteme girmek zorunda olmadığı için ilerleme NULL olabilir ve manuel doğrulanabilir.

alter table public.user_campaign_state
  add column if not exists qualifying_transaction_count integer;

alter table public.user_campaign_state
  add constraint user_campaign_state_qualifying_transaction_count_nonnegative
  check (qualifying_transaction_count is null or qualifying_transaction_count >= 0);

comment on column public.user_campaign_state.qualifying_transaction_count is
'Kampanya dönemindeki kullanıcı tarafından doğrulanmış uygun işlem adedi. NULL = bilinmiyor; karar motoru kesin ödül varsaymaz.';
