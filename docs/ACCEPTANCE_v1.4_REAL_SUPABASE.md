# v1.4 real-Supabase acceptance checklist

**Status: NOT YET EXECUTED against the production Supabase project.**

So far, v1.4–v1.4.3 have been verified in three ways:

- RLS, triggers and migrations on a **real PostgreSQL 16** with a Supabase role/`auth.uid()` stub (`server/tests/test_supabase_rls.py`);
- browser flows against a **mock** Supabase Auth/PostgREST (`web/e2e/account-smoke.mjs`);
- unit tests.

None of these exercise the real Supabase Auth service, email delivery, the real PostgREST, or the production database. v1.4 must not be called production-verified until this checklist is completed and signed off.

## Prerequisites
- [ ] `supabase/audit/rls_audit.sql` run before the migration; output saved.
- [ ] `008_user_profiles.sql`, then `009_eligibility_only_dimensions.sql`, then `010_option_criteria.sql`, run in the SQL Editor (each in full). All succeed.
- [ ] After 010: `select dimension_code, code from profile_dimension_options where dimension_code in ('maximiles_band','crystal_band')` shows only `band_1`…`band_4`; `select count(*) from profile_option_criteria` = 8.
- [ ] After 010: `select dimension_code, option_code, source_url, verified_at from profile_option_criteria order by 1,2` shows all 8 rows with a non-null `verified_at`. The Crystal rows cite `https://www.crystalcard.com.tr/crystal-dunyasi/varliga-bagli-crystal-ayricaliklari/…`. If an earlier 010 was already run, run the current 010 again to correct them.
- [ ] `rls_audit.sql` run again: `profiles`, `user_banks`, `user_profile_attributes`, `user_preferences` and `profile_dimension*` and `profile_option_criteria` show `rls_enabled = true`. Query 4 (user tables without RLS) returns **no rows**.
- [ ] Authentication → Email: sign-ups enabled. Note whether "Confirm email" is on or off.
- [ ] URL Configuration: Site URL / Redirect URLs include `https://melihdelier.github.io/Campaign-Hunter/`.
- [ ] v1.4.3 deployed. Info shows `v1.4.3` and a CI build ID.
- [ ] Two **test** mailboxes you control (A and B). Do not use other people's addresses.

## Flows (record date, device/browser, result, notes)

| # | Step | Expected | Result |
|---|---|---|---|
| 1 | Fresh browser profile (or a private window), open the app | The **Giriş** screen. No cards or results are visible. The bottom navigation is hidden. | |
| 2 | "Hesap oluştur" with mailbox A | If confirmation is **off**: you go straight to onboarding. If **on**: the message "E-postana gelen bağlantıyla doğrula…" appears. | |
| 3 | (Confirmation on) Open the email link on the same device | The app opens and the session is active (onboarding or Hangi Kart?). The `#access_token` is cleaned from the URL. | |
| 4 | Onboarding: TEB → TEB Özel Infinite → Ultra → Tamamla | Hangi Kart? opens. In Supabase Table Editor: `profiles.onboarding_completed_at` is set, and `user_banks`, `user_cards` and `user_profile_attributes` rows belong to A's `user_id`. | |
| 5 | Hangi Kart?: Da Mario, 5000 TL, Restoran | Only **TEB Özel Infinite** is listed. The core benefit is calculated, ~₺1.000 theoretical. | |
| 6 | Reload the page, then close and reopen the installed PWA | Hangi Kart? opens directly. **Onboarding does not reappear.** | |
| 7 | Open `#/kurulum` manually | You are redirected to Hangi Kart?. | |
| 8 | Profil › Bankalarım ve Kartlarım: add Akbank + Wings Black → Kaydet | "Kaydedildi ✓". New rows appear in the DB. | |
| 9 | Profil › Hesap → Çıkış yap | The Giriş screen appears. In DevTools → Application, `bka-supabase-session-v1` is gone. Optional: Supabase Auth logs show a logout. | |
| 10 | Sign in again as A | Hangi Kart? opens directly with the same TEB + Wings profile. No onboarding. | |
| 11 | Same device: sign out, then create account B | B starts **onboarding with nothing selected**. None of A's cards are visible. | |
| 12 | B: QNB → Miles&Smiles QNB Private → Private → Tamamla, then run Hangi Kart? | Only the QNB card is listed. | |
| 13 | Sign out B, sign in A on a **second device** (or another browser) | The same A profile loads. No onboarding. | |
| 14a | Profil › Müşteri Profili with İş Bankası + Maximiles Black (and Yapı Kredi + Crystal): pick a band | Chips show the dated labels ("1 milyon TL'ye kadar" …) and "Kaynak: resmi sayfa · doğrulandı 2026-10-03". The DB row has `option_code` = `band_N`, `criteria_version` = `v1` and `confirmed_at` set. No amount column exists. | |
| 14b | (SQL Editor, test project only) Simulate a threshold change: set `effective_to = current_date` on maximiles v1 rows and insert v2 rows from `current_date`, then reload the app | The Maximiles band shows a reconfirmation prompt. Hangi Kart? treats the band as unknown. The DB row still says `v1` until "Evet, …" + Kaydet, after which it says `v2`. Revert the simulation afterwards. | |
| 14 | Şifremi unuttum (A) | The reset email arrives. The link opens the app on Profil › Hesap, a new password can be set, and you can sign in with it. | |

## Cross-user isolation against the real API (must be done; frontend checks alone are not enough)

Use A's and B's access tokens. You can read them in DevTools from `localStorage['bka-supabase-session-v1'].access_token` while each user is signed in. `$URL` is the project URL and `$KEY` is the publishable key.

```bash
# As B, try to read A's rows (A_ID = A's user id from Authentication → Users)
curl -s "$URL/rest/v1/profiles?user_id=eq.$A_ID" -H "apikey: $KEY" -H "Authorization: Bearer $B_TOKEN"            # expect []
curl -s "$URL/rest/v1/user_cards?user_id=eq.$A_ID" -H "apikey: $KEY" -H "Authorization: Bearer $B_TOKEN"          # expect []
curl -s "$URL/rest/v1/user_profile_attributes?select=*" -H "apikey: $KEY" -H "Authorization: Bearer $B_TOKEN"     # expect only B's rows
# As B, try to modify / insert A's rows
curl -s -X PATCH "$URL/rest/v1/profiles?user_id=eq.$A_ID" -H "apikey: $KEY" -H "Authorization: Bearer $B_TOKEN" \
     -H "Content-Type: application/json" -H "Prefer: return=representation" -d '{"display_name":"x"}'               # expect [] (0 rows)
curl -s -X POST "$URL/rest/v1/user_preferences" -H "apikey: $KEY" -H "Authorization: Bearer $B_TOKEN" \
     -H "Content-Type: application/json" -d "{\"user_id\":\"$A_ID\",\"preferences\":{}}"                              # expect 403 / RLS violation
# Anonymous (publishable key only)
curl -s "$URL/rest/v1/profiles?select=*" -H "apikey: $KEY"                                                          # expect 401/permission denied or []
curl -s "$URL/rest/v1/catalog_snapshots?select=id&limit=1" -H "apikey: $KEY"                                        # expect the catalog row (public by design)
```

| Check | Expected | Result |
|---|---|---|
| B reads A's `profiles` / `user_cards` / `user_banks` / `user_profile_attributes` / `user_preferences` | `[]` for each | |
| B updates or deletes A's rows | 0 rows affected | |
| B inserts a row with A's `user_id` | rejected (RLS) | |
| anon reads any user table | denied or `[]` | |

## Sign-off
- Executed by / date:
- Supabase project:
- Email confirmation setting during test:
- Failures and follow-ups:

Only after every row above passes may release notes state "verified against production Supabase".

## Deployment note (forward requirement)

v1.4.3 is pre-public. Migration 010 renames option codes in a single step, which is acceptable only because there is no production profile data yet. From the first public release on, schema and data changes must follow backward-compatible **expand/contract**, so that a still-cached previous PWA client keeps working until it updates. See `ELIGIBILITY_SCHEMA_v1.md` §7.
