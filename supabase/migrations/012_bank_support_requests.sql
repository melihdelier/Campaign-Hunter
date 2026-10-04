-- ============================================================
-- 012_bank_support_requests.sql  (Campaign Hunter v1.5.0)
-- "Bankam listede yok": kullanıcı, listede olmayan bir banka için destek İSTEĞİ bırakır.
-- İstek kanonik ana veriye DOKUNMAZ: banka/kart/kampanya oluşturmaz, banks/card_products/card_programs'ı değiştirmez.
-- Kullanıcıya ait tablo → RLS: her kullanıcı yalnız kendi isteklerini görür/ekler/siler. Anonim erişim yok.
-- En çok istenen bankalar yalnız service_role ile okunabilen özet görünümünden (security_invoker) hesaplanır.
-- Tek transaction, tekrar çalıştırılabilir; mevcut veri değişmez.
-- ============================================================
begin;

create table if not exists public.bank_support_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  requested_name text not null check (char_length(btrim(requested_name)) between 2 and 80),
  -- Toplama anahtarı veritabanında hesaplanır (istemci farklı anahtar gönderemez):
  -- Türkçe harfler sadeleştirilir, harf/rakam dışı → '-', sondaki "bank/bankası/a.ş." atılır. "ING Bank" ve "ING" → "ing".
  normalized_key text generated always as (
    btrim(regexp_replace(btrim(regexp_replace(
      lower(translate(btrim(requested_name), 'ÇĞİIÖŞÜÂÎÛçğıöşüâîû', 'CGIIOSUAIUcgiosuaiu')),
      '[^a-z0-9]+', '-', 'g'), '-'), '(-(bankasi|bank|a-s|as))+$', '', 'g'), '-')
  ) stored,
  note text check (note is null or char_length(note) <= 280),
  created_at timestamptz not null default now(),
  unique (user_id, normalized_key)          -- aynı kullanıcı aynı bankayı tekrar isterse çift kayıt olmaz
);
create index if not exists idx_bank_support_requests_key on public.bank_support_requests(normalized_key);

alter table public.bank_support_requests enable row level security;
drop policy if exists "own rows select" on public.bank_support_requests;
drop policy if exists "own rows insert" on public.bank_support_requests;
drop policy if exists "own rows delete" on public.bank_support_requests;
create policy "own rows select" on public.bank_support_requests for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows insert" on public.bank_support_requests for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own rows delete" on public.bank_support_requests for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on table public.bank_support_requests from anon;
grant select, insert, delete on table public.bank_support_requests to authenticated;
grant all privileges on table public.bank_support_requests to service_role;

-- Toplama (yalnız service_role; RLS'i atlayan rol). security_invoker: authenticated kullanıcı erişse bile yalnız kendi satırları sayılırdı.
create or replace view public.bank_support_request_summary with (security_invoker = true) as
select r.normalized_key,
       count(*)::integer as request_count,
       min(r.created_at) as first_requested_at,
       max(r.created_at) as last_requested_at,
       (array_agg(r.requested_name order by r.created_at desc))[1] as latest_name,
       exists (select 1 from public.banks b where b.code = r.normalized_key) as matches_existing_bank
  from public.bank_support_requests r
 group by r.normalized_key;
revoke all on table public.bank_support_request_summary from anon, authenticated;
grant select on table public.bank_support_request_summary to service_role;

comment on table public.bank_support_requests is 'Kullanıcının listede olmayan banka için destek isteği. Kanonik ana veriyi DEĞİŞTİRMEZ.';

commit;
