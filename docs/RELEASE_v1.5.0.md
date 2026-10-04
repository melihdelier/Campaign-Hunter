# Campaign Hunter v1.5.0 — consolidated release (baseline: v1.4.4, not separately deployed)

v1.5.0 includes the complete v1.4.4 auth hotfix. Nothing was deployed or pushed by the build process.

## What's in it

| Phase | Result |
|---|---|
| 0 Auth hotfix | Preserved unchanged: `getAuthRedirectUrl()`, explicit signup/reset `redirect_to`, callback capture before the router, `/Campaign-Hunter/` base path. All auth unit and browser tests pass. |
| 1–2 Master data | 10 banks. Bank → program → product → dimensions → criteria. `card_programs` has 11 verified or operating-source programs; DenizBank has no program (not verified). No invented products, segments or benefits. |
| 3 Coverage | `bank_coverage` + `web/coverage.js`. Facets are `full/partial/none/coming`; support levels are `full/partial/profile_only/coming/unsupported`; freshness is `verified/last_known/stale/unverified`. |
| 4 Source registry | `server/source_catalog.json` (config) + `catalog.meta.sourceRegistry` (runtime state). New-bank sources are registered but disabled and never fetched. Crawling stays global, central and twice daily. |
| 5 Support requests | `bank_support_requests` (RLS, own rows) + a service-role-only aggregate view. Requests never change canonical data. "Bankam listede yok" link in the bank lists. |
| 6 Original six | Ordinary rows in the general model (`program_code`). No product-specific code paths; legacy mode is data-driven and identical to v1.4.4 (30,720 combinations). |
| 7 Wings / TEB | Display names are "Classic / Black / Black Plus" and "Standart / Plus / Premium / Ultra". Codes are unchanged. The Wings `engine_label` is kept only as the legacy `segmentRules` key (contract later). No threshold criteria were invented. |
| 8–9 Eligibility output | The crawler dual-writes `eligibilitySchemaVersion: 1` + `eligibilityRule` (+ `rewardVariants` from `segmentRules`) next to the unchanged legacy fields, only where the translation is exact. A cross-language parity test (Python output → real JS client) finds 0 mismatches. The only intentional change is QNB Terminal Kadıköy (official page verified). |
| 10 rewardVariants | Wired into `resolveSegmentCampaign`: the first definitely-true variant is the actual reward, false variants are skipped, unknown ones are kept as conditional only, and an explicit `always` is required for a floor. There is no implicit base fallback; unresolved means informational with no amount. |
| 11 Single truth | Kampanyalar and Hangi Kart? resolve eligibility and reward through the same functions and context (parity tested). Hangi Kart? uses the actual profile and owned cards only. |
| 12 Hypothetical | `web/opportunity.js`: overlay profile, missing requirements, potential reward and delta. No UI, no persistence, no qualification claim. |
| 13 Coverage UX | Bank badges, a "kart listesi hazırlanıyor" message, a one-line Hangi Kart? note only for banks that can't contribute yet, and a coverage table in Profil › Uygulama Bilgisi. Users can finish onboarding with only a card-less bank. |
| 14 New-bank campaigns | Not populated. No crawler, products or campaign data for Garanti, Ziraat, Halkbank, VakıfBank or DenizBank. |
| 15 Actions summary noise | The guard reports to Actions only in real runs. Guard unit tests set `CATALOG_GUARD_ACTIONS_REPORTING=0` and capture stdout. Tested both ways. |
| 16 Actions maintenance | checkout v5, setup-python v6, setup-node v5 (Node 22 for tests), configure-pages v6, upload-pages-artifact v5, deploy-pages v5. Runner pinned to `ubuntu-24.04`. |
| 17 Security | All existing RLS kept. New global tables are authenticated read-only and hidden from anon. The new user table has own-row RLS. No card number, CVV, password or asset amount columns (tested). |
| 18 Migrations | `011_master_data_coverage.sql`, `012_bank_support_requests.sql`. Expand-only, transactional, repeatable. 008–010 are untouched. |

## Replacement build: crawl first, personalize after

This build replaces the earlier v1.5.0 ZIP (still not deployed). Everything listed above is kept.

| # | Requirement | Result |
|---|---|---|
| 1, 16 | Global, user-independent catalog | Source rows no longer carry `card_products`. The crawler has no user, profile, owned-card or segment input. `test_discovery_v15` runs the real pipeline twice, with and without "user" state, and requires identical campaigns and reports. Changing card lists never changes discovery. |
| 2 | No source → card assumption | `generic_parse` and `known_core_fallback` no longer use the source's cards. Cards come per campaign from official structured data, else the campaign's own terms, else a per-URL verified override. Free text never creates products. |
| 3 | Unknown card/segment keeps the campaign | `eligibilityResolution.state` is one of resolved / partial / unresolved / needs_review. Unresolved and needs_review records keep `cardProductIds: []`: they stay in the catalog and diagnostics and are never applicable (JS fails closed). |
| 4 | Wings | Uses the official JSON `/api/campaign/list?page=N` behind the client-rendered page (`list` + `overSoonList` + `randomList`, deduplicated; `totalCount`/`pageCount`; `card_type` → canonical products; official sector → category). Playwright isn't needed. |
| 5 | All sources audited | See the source table below. |
| 6 | Completeness metrics | Per source in `meta.source_reports`, `sourceRegistry[].metrics` and the Actions guard summary. "25 candidates / 1 record" counts as `incomplete`, and LKG equality is not completeness. Fail-closed/LKG protection is unchanged. |
| 7 | TEB general | Discovered from the official sitemap (the listing is client-rendered). The manual fallback list was removed. There is a regression fixture for "Giyim Alışverişlerinize Toplam 1.200 TL Bonus!" at the current official detail URL `/sizin-icin/giyim-alisveris/`, with the official terms: not Ultra-only, 120 TL per 3.000 TL+ transaction, max 1.200 TL. The retired URL `/sizin-icin/giyim-alisverislerinize-bonus/` now redirects to the listing and is rejected as `category_listing` (regression test). |
| 8–10 | Category-only Hangi Kart? | The merchant is optional, and there is no "İşyeri adı girilmedi" block. Merchant scope decides: category-wide is calculated normally; a network/participating list gives a conditional result with the required warning (never the winner); brand/exact go to "Bu kategoride işyeri özel fırsatlar". A manual category is authoritative; inference applies only with "Otomatik". |
| 11 | Locked giyim regression | `web/test-v15-discovery.mjs` + `e2e/discovery-smoke.mjs` run over genuine crawler output (`web/fixtures/giyim-regression.v1.json`). TEB gives 120 TL (not 1.200) in the conditional merchant section, because it is limited to Bonus-member merchants. QNB gives 500 Mil (not 1.000), no MercedesCard under Maximiles Black, and no hubs. |
| 12 | Page kinds | campaign_detail / category_listing / program_listing / navigation / unknown. Only details are emitted. There are Maximiles hub tests, with and without configured `hub_slugs`. |
| 13 | Narrow "Potansiyel" | Location, channel, category, card and segment are hard mismatches. Only adjustable amount thresholds are potential. |
| 14 | Actual profile + owned cards | Unchanged. MercedesCard campaigns stay in the global catalog ("Bankalarının diğer kartlarına ait kampanyalar"). |
| 15 | Kampanyalar default | Shows definitely applicable campaigns only. Collapsed sections hold "Bilgi amaçlı", "Kart uygunluğu doğrulanamayan" and "Diğer kartlar" (only your banks). |
| 17 | New banks | Still no crawlers. |
| 18 | v1.5 work | Kept. Small extras: the global catalog reloads after sign-in, and the coverage table shows source confidence. |

**Other parser fixes found by the regression:**

- "Toplam 1.200 TL Bonus" / "toplamda 2.000 Mil" is a reward total, not a cumulative-spend condition.
- "N TL, toplam M TL <unit>" reads N as the per-transaction reward.
- A channel qualifier must govern the same clause ("yalnızca fiziki POS …; online … dahil değil" → physical).
- A sector + "alışveriş/harcama" title is category-wide.
- Explicit member/contracted merchant wording is a merchant network (`merchantScope {kind:"restricted_unknown", scopeType:"network", networkLabel}`), not category-wide. This covers "Bonus üyesi … işyeri/mağaza", "üye işyerlerinde/mağazalarda" and "anlaşmalı işyeri/mağaza". The reward stays exact (`rulesComplete` is not lowered). With an empty merchant, Hangi Kart? shows it only as a conditional result ("Bu avantaj ilgili üye işyerinde geçerlidir; işyerinin kampanyaya dahil olduğunu doğrula."); it is never the ranked winner.
- A plain sector/MCC condition (QNB giyim/kozmetik) stays category-wide, and the "aynı gün aynı üye işyeri" boilerplate is ignored.
- Page kind is decided before the length check, so a retired detail URL that redirects to a short client-rendered listing is reported as a listing, not a parse error.

### Card family / program scope (final correction)

- **No single-product inference.** Campaign scope is never inferred from the fact that only one product of a family exists in master data.
  - TEB giyim targets `teb-bonus-individual-credit` (TEB Bonus-featured individual credit cards).
  - QNB giyim targets `miles-smiles-qnb` (the Miles&Smiles QNB card family).
  - Both carry `cardProductIds: []`, state `partial` (family membership is incomplete in master data), and rule `{payWith:{families:[…]}}`.
- **Rule language.** Eligibility rule v1 now accepts `payWith/owns.families` (JS evaluator + both validators + shared validation cases). Owned products match through master-data membership (`CARD_ELIGIBILITY_FAMILIES`), so a future member product matches with no campaign change.
- **Scope is not broadened.** TEB Bonus ≠ every TEB card, and Miles&Smiles QNB ≠ every QNB card.
- **Other families now in use:** Wings, Maximiles, Maximum-featured, bank individual-credit, World-featured. Explicitly named products (Wings Black/Elite API tokens, "Miles&Smiles QNB Private", "TEB Özel Infinite") stay product-level, and per-URL verified overrides are unchanged.
- **Regression tests (JS + Python):**
  - TEB Infinite matches the TEB Bonus-family campaign today;
  - a future second TEB Bonus card matches without changing the record, while a non-Bonus TEB card does not;
  - M&S QNB Private matches today, and another M&S QNB product matches, while an ordinary QNB card does not;
  - the records stay family-scoped and unchanged.
- **Transition (expand):** cached v1.4.2–v1.4.4 clients reject the new `families` key and fail closed for these records. No migration, so 011/012 are still unchanged and there is no 013.

### TEB giyim — official terms used (teb.com.tr/sizin-icin/giyim-alisveris/, 1–31 October 2026)

| Term | Value | Catalog field |
|---|---|---|
| Cards | TEB individual Bonus-featured credit cards; Sade, debit and commercial cards excluded | `cardFamilies: ["teb-bonus-individual-credit"]` (state `partial`), `excluded: ["commercial"]` |
| Merchants | Bonus-member clothing / accessories / cosmetics / shoe merchants | `categories: ["giyim"]`, `merchantScope.scopeType: "network"` |
| Reward | Each single transaction of 3.000 TL or more → 120 TL Bonus | `rewardRule {kind:"fixed", minSpend:3000, reward:120}` |
| Cap | 1.200 TL Bonus per campaign | `periodCap: 1200` |
| Same day / same merchant | Only the first transaction | `sameDaySameMerchantFirstOnly: true` |
| Enrollment | Required before the first transaction | `requiresEnrollment: true` |
| Location / channel | Domestic only; physical and virtual POS / internet | `location: "domestic"`, `allowedChannels: []` |

### Source-by-source (audit 2026-10-04)

**How these figures were gathered.**

- Audit figures come from the official pages and APIs, fetched with a page-reading tool.
- The build sandbox's network policy blocks bank hosts for the crawler itself, so no live crawl ran here.
- Active / resolved / unresolved / expired / parse-error counts are therefore **not yet measured**. The first production run reports them per source in the Actions guard summary and in `meta.source_reports`.
- Coverage confidence below is what the run can at most report for each mechanism. No source is labelled "full".

| Source | Official listing | Mechanism (chosen) | Candidates seen in audit | Detail URLs | Active · resolved · unresolved · expired/rejected · parse errors | Max confidence |
|---|---|---|---|---|---|---|
| wings | wingscard.com.tr/kampanyalar (client-rendered "Kampanyalar Yükleniyor…") | **json_api** `/api/campaign/list?page=N` + server-rendered /ayricaliklar, /wings-style, /programlar + 1 verified core URL | API `totalCount` 150, `pageCount` 17, 8 per page | API urls (`/kampanyalar/<slug>`), server-rendered detail with terms | first run | **high** only if the deduplicated enumeration = `totalCount` and all active items parse; otherwise partial |
| axess_general | axess.com.tr/axess/kampanyalar | listing_html (6 server-rendered + JS "Daha Fazlasını Göster"; no endpoint found; sitemap has only the root) + 5 reviewed URLs | 6 | 6 + 5 | first run | low (no enumerable source) |
| maximiles | maximiles.com.tr/kampanyalar/tum-kampanyalar (6 + show-more) | **sitemap (always)** + listings + 6 official category pages; hubs rejected by `hub_slugs` + structure | sitemap: 597 locs, 415 under /kampanyalar/ (incl. hubs + history) | up to 600 | first run | medium (sitemap fully read; no official active count) |
| world | worldcard.com.tr/kampanya (6 + show-more) | **sitemap (always)** + 6 listings + 7 category pages | sitemap: 520 locs, 487 under /kampanyalar/ (incl. history) | up to 600 | first run | medium |
| teb_general | teb.com.tr/sizin-icin/kampanyalar/?cat=Kredi+Kartı (client-rendered) | **sitemap (always)** teb.com.tr/sitemap.xml + listing; manual fallback list removed | not reachable from the audit tool (robots.txt fetch failed) | up to 400 | first run | medium if the sitemap is reachable; otherwise the run shows 0 / incomplete and the guard keeps LKG |
| teb (Kart Dünyası) | teb.com.tr/kart-dunyasi/, /infinite-card/ | listing_html + 7 reviewed URLs (6 verified overrides) + sitemap if < 18 candidates | not reachable from the audit tool | 7+ | first run | low–medium |
| qnb_card | qnbcard.com.tr/kampanyalar | listing_html (12 in HTML + JS "Daha Fazla Göster", no endpoint visible); sitemap.xml returns 404 → removed | 12 | 12 | first run | low |
| qnb_ms | milesandsmilesqnb.com.tr/kampanyalar | listing_html (static, 9 campaigns, no show-more); its sitemap lists an old domain → removed | 9 (incl. the giyim 2.000 Mil campaign) | 9 | first run | medium (static complete list, no official count) |
| qnb_private | qnb.com.tr/private/private-ayricaliklar | listing_html (static; 4 links + 9 offers on "Ayrıcalıklar ve Teklifler") | 4 + 9 | ~13 | first run | medium |
| crystal_special | yapikredi.com.tr/…/otel-restoran-indirimleri, crystalcard.com.tr/…/yurtici-anlasmali-otel-and-restoran-indirimleri | 2 fixed official pages (server-rendered; 150+ merchants) | 2 | 2 | first run | medium (fixed scope) |

The offline pipeline proof (`server/tests/test_discovery_v15.py`, run on fixtures) gave:

- **wings:** json_api, official 10, enumerated 10, 1 expired, 9 active parsed → complete/high.
- **teb_general:** sitemap, 5 candidates; 1 expired, 1 navigation page and 1 retired URL redirecting to the listing rejected; 2 active (giyim 120 TL as a merchant network, plus yurt dışı) → partial/medium.
- **maximiles:** 2 configured hubs not fetched and 1 structural hub rejected; MercedesCard → partial with no products; "Kitap" → unresolved.
- **qnb_ms:** static listing, 1 resolved.

### Migrations for this build

- **`011_master_data_coverage.sql` and `012_bank_support_requests.sql` are unchanged.**
- **No migration 013 was needed.** Every change lives in the published catalog JSON (`eligibilityResolution`, `pageKind`, `bankCode`, `meta.source_reports` metrics, `sourceRegistry[].metrics`) or in client code; no table or column changed.

## Migrations (run in order in the Supabase SQL Editor; each in full)

1. **`011_master_data_coverage.sql`**
   - Adds the 5 new banks and the `card_programs` table (+ seed).
   - Adds `card_products.program_code` (nullable).
   - Adds the `bank_coverage` table (+ seed).
   - Updates the Wings/TEB display labels.
   - Adds RLS and grants.
2. **`012_bank_support_requests.sql`**
   - Adds the `bank_support_requests` table (generated `normalized_key`, unique per user + key).
   - Adds own-row RLS.
   - Adds the `bank_support_request_summary` view (service_role only).

Both preserve all user data: profiles, banks, cards, attributes and criteria confirmations are unchanged (tested on a real-PostgreSQL upgrade from 010). A cached v1.4.4 PWA keeps working. The new client also works before 011 runs: programs and coverage fall back to the bundled data, and new banks appear once the server has them.

## Single GitHub web deployment procedure (final ZIP)

1. **Back up first** (Supabase SQL Editor): run `supabase/audit/rls_audit.sql` and save the output.
2. **Run migrations 011 and 012** (above) in the SQL Editor. Then run `rls_audit.sql` again: query 4 must return no rows.
3. **Unpack** `Campaign-Hunter-v1.5.0.zip` locally. Its root folder is `Campaign-Hunter-v1.5.0/`.
4. On GitHub (web), open the repository → **Add file → Upload files**.
   - Drag in **the contents** of `Campaign-Hunter-v1.5.0/`, not the folder itself.
   - Include the hidden `.github` folder. If your file browser hides it, make it visible first. The workflow change in `.github/workflows/pwa-pages.yml` is part of this release.
   - **Commit directly to `main`** with the message "v1.5.0".
   - Do not change any repository Variables or Secrets (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`); none are needed.
5. **Watch the "PWA katalog ve yayin" run** (Actions tab). It runs: test → build (fetch-lkg → crawl → guard → publish) → deploy → catalog-health.
   - The test job summary should not contain "rejected".
   - The build summary shows the real guard verdict.
6. **Open** https://melihdelier.github.io/Campaign-Hunter/ → Profil › Uygulama Bilgisi should show v1.5.0. Reload once if the old version is still shown (the service worker updates on the next load).
7. **Run** the v1.5.0 rows (V1–V11) and the v1.4.4 rows (H1–H4) in `docs/ACCEPTANCE_v1.4_REAL_SUPABASE.md`.

## Manual settings that still need attention

- **Supabase Auth → URL Configuration** (from v1.4.4, if not done yet):
  - **Redirect URLs** must allow `https://melihdelier.github.io/Campaign-Hunter/` (or `…/Campaign-Hunter/**`).
  - **Site URL** is recommended to be the same.
- **No new GitHub variables or secrets.**
- **Repository settings → Pages:** keep the source as "GitHub Actions".

## Unresolved risks / follow-ups

- **TEB pages were not readable from the build environment.**
  - The TEB giyim fixture now carries the official terms the owner supplied (see the table above).
  - Live TEB parsing is still verified on the first run (V17).
  - TEB's corporate list is served by `TebPublicServiceProxy.asmx/GetFirsatlarKurumsalWeb`. A personal-card equivalent was not verified, so it is not used.
- **First production run is the real measurement.** Live per-source counts appear in the Actions summary. Watch for `incomplete` rows, and for Wings `official_count` ≠ enumerated.
- **More pages fetched.** Maximiles and World now read their full sitemaps (up to 600 details each). This takes longer but stays within the twice-daily window.
- **Stricter eligibility means fewer applicable campaigns.**
  - Campaigns whose terms never name a card family (e.g. Wings pages without card wording and no API `card_type`) become `unresolved` and are no longer applied.
  - Pre-v1.5 LKG records are re-resolved from their short summaries. Some will be `unresolved` until a fresh crawl replaces them.
- **Kampanyalar shows fewer items by default.** Incomplete campaigns moved into the "Bilgi amaçlı" section.

- **New banks have no crawling yet.** Garanti, Ziraat, Halkbank and VakıfBank have no adapters or product mapping, so no campaigns. Each needs source parsing verification and product master data before its registry row is enabled. DenizBank's official program source wasn't verified in this release.
- **Legacy keys are still dual-written** (contract pending): `segmentLabels` / `segmentRules`, and the Wings `engine_label` with thresholds. Remove them only after v1.4.x clients can no longer be active.
- **Core benefits in `bootstrap-data.js`** stay on the legacy adapter (parity-proven). Moving them to v1 fields can happen with the contract step.
- **QNB Terminal Kadıköy divergence:** during the transition, old cached clients still see it as Private-only (more conservative), while new clients use the official 10/15/20%.
- **Coverage values for partial banks** are declared conservatively by hand. No bank is "full", which is honest but means the "Kısmi destek" badge appears for every current bank in the picker.
- **Actions versions** were checked against the official release pages on 2026-10-04. The v7 lines of checkout, setup-python and setup-node are newer but were deliberately skipped: their ESM and behaviour changes aren't needed here. `actions/upload-pages-artifact@v5` excludes dotfiles; the deployed `web/` folder has none.
- **No real email or Supabase run yet.** Real email confirmation and production-Supabase checks remain manual (acceptance checklist).
