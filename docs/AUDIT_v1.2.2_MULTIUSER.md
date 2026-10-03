# Campaign Hunter: v1.2.2-supabase audit for the multi-user evolution

Baseline: `v1.2.2-supabase` (commit `520574c`). Scope: repository source only. I don't have access to the live Supabase project; anything stated about the live DB is "as defined by the repo SQL" and should be confirmed with `supabase/audit/rls_audit.sql`, which is read-only.

## 1. Current authentication architecture

| Aspect | What it does today |
|---|---|
| Client | `web/cloud-sync.js`. A hand-written REST client against Supabase GoTrue/PostgREST, with no supabase-js dependency. |
| Method | **Email + password.** `signUp` uses `POST /auth/v1/signup` and `signIn` uses `POST /auth/v1/token?grant_type=password`. |
| Session | The full token response is stored in `localStorage['bka-supabase-session-v1']`. `refreshSessionIfNeeded()` refreshes the access token with the refresh token once it is within 60 s of expiring. The session therefore survives app restarts. |
| Logout | `signOut()` **only deletes the localStorage key**. It never calls `POST /auth/v1/logout`, so the refresh token stays valid on the server. |
| Where "Giriş yap" lives | Ayarlar → "Bulut ve cihazlar arası senkron" card (email/password fields, Giriş yap / Hesap oluştur / Çıkış). |
| Role of auth in the app | **Optional.** The app is fully usable without signing in. Auth is only used for *manual* push/pull of one JSON row (`user_app_state`) through "Bu cihazı buluta gönder" and "Buluttan bu cihaza al". |
| Profile ownership | None. The card portfolio and segments are **not** tied to the account: they live in the device-wide localStorage key `banka-kampanya-avcisi-v10`, which is shared by every account used on that browser. |
| Account switching | Signing in as a different user does **not** reset local data. User B would see user A's cards, segments and limits on a shared device. |

Verdict: the email/password mechanism is sound and already verified in production (login works and `user_app_state` was written). It should be **reused**. The things missing are the ownership model, server-side logout, a per-user local cache, and auto-loading the profile.

## 2. Supabase tables, migrations and RLS status (as defined in the repo)

Source files: `supabase/migrations/001…006` and `supabase/BKA_Supabase_Kurulum_Tek_Sorgu.sql` (the one-shot setup = 001–006 plus a `007_explicit_data_api_grants` block). **Gap:** the 007 grants exist only in the one-shot file; there is no `migrations/007_*.sql`.

| Table | Kind | Used by app? | RLS | Policies |
|---|---|---|---|---|
| `banks` | master | no (seeded 5 banks) | on | select → authenticated |
| `card_products` | master | no (seeded **only the 6 products of the original owner's portfolio**) | on | select → authenticated |
| `campaigns`, `campaign_card_eligibility` | master | **no** (the catalog actually lives in `catalog_snapshots.payload` JSON) | on | select → authenticated |
| `catalog_snapshots` | master | **yes** (PWA catalog read; crawler writes with the secret key) | on | select → anon, authenticated (id=1) |
| `user_cards` | user | no | on | ALL own-row (`auth.uid() = user_id`) |
| `user_campaign_state`, `…_events` | user | no | on | own-row (events: select+insert) |
| `private_campaigns` | user | no | on | ALL own-row |
| `user_reward_profile` | user | **no** | on | ALL own-row. **Column defaults encode the owner's portfolio** (`wings_tier black_plus`, `maximiles_band 4m_8m`, `qnb_segment private`, `teb_tier ultra`), and the `crystal_card_type` check lacks `crystal_and_metal`. |
| `user_app_state` | user | **yes** (manual sync row: settings, campaign_states, private_campaigns) | on | select/insert/update own-row; **no delete policy** |

Grants (007 block): authenticated has select on the master tables and CRUD on the user tables; anon only has select on `catalog_snapshots`; service_role has all. RLS is enabled on every table and every user-table policy resolves to `auth.uid() = user_id`. As written, I see no permissive cross-user policy.

## 3. Current navigation

There are five top-level tabs (a bottom bar on mobile): **Özet** (default), **Kampanyalar**, **Hangi Kart?**, **Özel Kampanya Ekle** ("Ekle" on mobile) and **Ayarlar**. Ayarlar is one long screen that mixes the segment selectors, stale-days setting, cloud auth and sync, PWA install, refresh, backup, and the security note. The version is shown in the top bar and nowhere else.

## 4. Where personal configuration is stored or hard-coded

| Location | Content | Personal or master? |
|---|---|---|
| `web/bootstrap-data.js` `initialCards` | The owner's 6 cards with fixed segments, all `active:true` | **Personal**, currently acting as the universal default |
| `web/app.js` `seed()` and `load()` settings defaults | `qnbSegment:private, wingsTier:black_plus, maximilesBand:4m_8m, crystalBand:under_1m, tebTier:ultra, thyStatus:classic` | **Personal** |
| `web/index.html` | `selected` attributes on the same values; the private-campaign card list is hard-coded to the owner's 6 products | Personal (UI) |
| `supabase` `user_reward_profile` defaults and `card_products` seed | Owner's portfolio | Personal defaults / incomplete master |
| `server/source_catalog.json` `card_products` per source | The crawler only attaches campaigns to the owner's 6 products | Master, but **owner-scoped**, which limits catalog coverage for other users |
| `bootstrap-data.js` `initialCampaigns` (core benefits) | Wings / Maximiles Black / TEB Infinite / Crystal verified rules | **Master**: keep it global |
| `loyalty.js` selector constants and earn formulas | Valid tiers and earn rules per program | **Master**: keep it global (to become data-driven) |
| `app.js` `syncCardSegmentsFromSettings()` | Hard-coded mapping from settings key to product segment | Glue code that will become data-driven |

## 5. How campaign eligibility works today

`engine.js` is **card-centric**. For each user card it evaluates catalog campaigns where `campaign.cardProductIds` includes `card.cardProductId`, then:

- runs a segment check (`eligibility.segmentLabels` against the card's single `segment` string);
- applies segment-specific rule variants (`segmentRules`);
- applies validity periods, official-source date conflicts and combined customer caps;
- checks category, merchant scope, amount threshold, location and channel.

Bank-wide campaigns are represented by listing all of that bank's products in `cardProductIds`. Restrictions like "Card A AND segment X" or "Card A OR card B" can only be expressed through `cardProductIds` plus `segmentLabels`. There is no machine-readable OR/AND group model, no excluded cards or segments, and no attribute dimensions beyond one segment label per card. The campaign browser (`campaign-browser.js`) uses a **separate** but equivalent check (`campaignAppliesToCard`).

## 6. How "Hangi Kart?" derives its recommendations

`recommend({cards, campaigns, states, …})` iterates over `data.cards` (the owner's bootstrap cards, active only). For each card it evaluates the eligible campaigns, chooses the best one, and adds that card's **base loyalty earning** (`calculateLoyalty`). Cards are then ranked. The engine already only recommends cards that are in `cards`, so personalisation mainly means **deriving `cards` (with segments and attributes) from the authenticated user's profile** instead of from the bootstrap.

## 7. Reusable parts

- The **engine** (eligibility, periods, caps, core benefits, new-period policy, Istanbul calendar) and its tests. It is already parameterised by `cards`.
- The **Supabase REST client and session refresh**, the email/password auth, the RLS conventions, the `user_cards` table, and the `banks` / `card_products` master tables (these need columns and seed expansion).
- The **catalog pipeline** (crawler, guard, LKG fallback, `catalog_snapshots`) stays global and unchanged.
- `catalog-state.js` (state preservation, private campaigns) and `user_app_state` (per-user progress and private campaigns).

## 8. What needs migration or refactoring

1. **Navigation and IA (v1.3):** HTML structure and a router; no data changes.
2. **Master data:** generic profile dimensions (`profile_dimensions` + `profile_dimension_options`) so new segments and statuses are added as data; expand `card_products` (family, sort order, active).
3. **User data:** `profiles` (onboarding completion), `user_banks`, `user_cards` (reused; `segment_label` deprecated), `user_profile_attributes` (generic replacement for segment/status/tier columns), `user_preferences`. All need RLS with own-row policies for select/insert/update/delete, plus grants. Delete user cards when their bank is removed. Leave `user_reward_profile` in place as deprecated.
4. **Auth client:** server-side logout, a per-user local cache namespace (and a reset on account switch), automatic profile load on startup, and an onboarding gate.
5. **Eligibility (v1.5):** a machine-readable eligibility block on catalog campaigns (any-of / all-of groups over banks, products, product families and dimension options, plus exclusions), shared by the Campaigns screen and "Hangi Kart?" through one eligibility module.
6. **Crawler:** the per-source `card_products` are owner-scoped; broaden them once the product master grows. This is a v1.5+ data task.

## Proposed path

**v1.3.0 (this release): UI only, smallest safe change.** Hangi Kart? becomes the default and emphasised screen. The navigation is reduced to *Hangi Kart? · Kampanyalar · Profil*. Özet moves to Profil → Veriler / Özet. "Ekle" is reached from a `+` on Kampanyalar. Profil is split into Bankalarım ve Kartlarım, Müşteri Profili, Tercihler, Veriler / Özet, Hesap and Info. Version, build and release notes are shown only in Info, with service-worker cache invalidation per build. Existing element IDs and handlers are kept, so the engine, sync, catalog and auth behave exactly as before.

**v1.4.0: auth, per-user profile, onboarding and RLS.** Keep email/password, which already works in production (magic links open in Safari rather than the installed iOS PWA, which would break "stay signed in" there). Add server-side logout, a per-user cache and an onboarding gate. Add additive migration `008_user_profiles.sql` (new tables, RLS, grants, indexes, seeds) and `007` as a separate file mirroring the one-shot. Add an RLS test harness that runs the migrations on a local or CI Postgres with stubbed `auth.uid()` and proves user A can't read or modify user B's rows. On a user's first v1.4 login, an existing `user_app_state.settings` only **pre-fills** onboarding; it is never silently auto-completed.

**v1.5 → v1.7:** as in the brief (eligibility layer, category UX, polish).
