-- Campaign Hunter — READ-ONLY RLS / grants audit. Supabase SQL Editor'da çalıştırın; hiçbir şeyi değiştirmez.

-- 1) public şemasındaki tablolar ve RLS durumu
select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;

-- 2) Tüm politikalar (komut, roller, USING / WITH CHECK ifadeleri)
select tablename, policyname, cmd, roles, qual as using_expr, with_check
from pg_policies where schemaname = 'public'
order by tablename, policyname;

-- 3) anon / authenticated tablo yetkileri
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
group by table_name, grantee
order by table_name, grantee;

-- 4) user_id kolonu olan ama RLS'i kapalı tablo var mı? (boş dönmeli)
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
join information_schema.columns col on col.table_schema = n.nspname and col.table_name = c.relname and col.column_name = 'user_id'
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

-- 5) Kullanıcı tablolarındaki satır sayıları (yalnız sayı; içerik okunmaz)
select 'user_app_state' as t, count(*) from public.user_app_state
union all select 'user_cards', count(*) from public.user_cards
union all select 'user_reward_profile', count(*) from public.user_reward_profile;
