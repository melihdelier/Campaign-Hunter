# Master data, coverage, source registry and support requests (v1.5.0)

## 1. Model layers

| Layer | Where | Identity | Notes |
|---|---|---|---|
| Bank | `banks` / `PROFILE_BANKS` | `code` (e.g. `garanti`) | Stable. A bank may have no products, dimensions, benefits or crawler. |
| Card program / family | `card_programs` / `PROFILE_CARD_PROGRAMS` | bank-scoped `code` (e.g. `bonus-garanti`, `wings`) | Only programs verified against an official source. `verified_at` = source verification (global). |
| Card product | `card_products` (+ `program_code`) / `PROFILE_CARD_PRODUCTS` | `code` | Only products whose eligibility or reward behaviour differs. No cosmetic variants. |
| Profile dimension | `profile_dimensions` + options | dimension `code` + option `code` | Independent. A card can have several at once (segment, tier, loyalty status, asset band, card type …). Never merged into one `segment` string. |
| Criteria metadata | `profile_option_criteria` | (dimension, option, criteria_version) | Dated and source-backed, e.g. `ultra` = stable code, "10M+" = criterion. Thresholds never enter identity. |
| Coverage | `bank_coverage` / `BANK_COVERAGE` + `web/coverage.js` | bank | Explicit per facet. Listing a bank ≠ supporting it. |

The original six products are ordinary rows in this model. There are no product-specific code paths left: legacy mode now derives card fields from the dimension ↔ `settingKey` ↔ product mapping. A test checks this is identical to v1.4.4 across 30,720 combinations.

### Banks in v1.5.0

| Bank | Program(s) | Card products | Dimensions | Core benefits | Campaign crawler | Support level |
|---|---|---|---|---|---|---|
| Akbank | Wings, Axess | Wings Elite, Wings Black | `wings_tier` | Wings restaurant | wings, axess_general (active) | partial |
| İş Bankası | Maximiles | Maximiles Black | `maximiles_band` | Maximiles restaurant | maximiles (active) | partial |
| QNB | QNB Card, Miles&Smiles QNB | Miles&Smiles QNB Private | `qnb_segment`, `thy_status` | Private benefits | qnb_card, qnb_ms, qnb_private (active) | partial |
| TEB | — (not verified) | TEB Özel Infinite | `teb_tier` | Kart Dünyası | teb, teb_general (active) | partial |
| Yapı Kredi | World, Crystal | Crystal | `crystal_band`, `crystal_card_type` | Crystal restaurant/hotel | world, crystal_special (active) | partial |
| Garanti BBVA | Bonus | — | — | — | garanti_bonus (configured, **disabled**) | coming |
| Ziraat Bankası | Bankkart | — | — | — | ziraat_bankkart (configured, **disabled**) | coming |
| Halkbank | Paraf | — | — | — | halkbank_paraf (configured, **disabled**) | coming |
| VakıfBank | Vakıfkart (VakıfBank Worldcard) | — | — | — | vakifbank_vakifkart (configured, **disabled**) | coming |
| DenizBank | — (official source not verified in this release) | — | — | — | — | unsupported |

Program sources were verified on 2026-10-04 against the official campaign pages: bonus.com.tr (T. Garanti Bankası A.Ş.), bankkart.com.tr (T.C. Ziraat Bankası A.Ş.), paraf.com.tr (Türkiye Halk Bankası A.Ş.) and vakifkart.com.tr (VakıfBank). Wings, Axess, Maximiles, QNB Card, Miles&Smiles QNB and World cite the production crawler's existing official source, with `verified_at` null (an operating source, not separately label-verified). Crystal was verified on 2026-10-03.

Adding a future bank (ING, Kuveyt Türk, Türkiye Finans …) is data only:

1. Add a `banks` row and a `bank_coverage` row.
2. Optionally add verified `card_programs` and products.
3. Add a `source_catalog.json` entry (disabled until an adapter exists).
4. Regenerate `server/eligibility_master.v1.json` (`node tools/gen-eligibility-master.mjs`).
5. Write a new migration with the seed, then run `supabase/regen.sh`.

## 2. Coverage model (`web/coverage.js`)

**Facets** are independent: `masterData`, `cardProducts`, `profileDimensions`, `coreBenefits`, `campaignSources`, `campaignCrawler`, `campaigns`. Their values are `full | partial | none`, plus `coming` for campaign facets.

**Support level** is derived, not stored: `full | partial | profile_only | coming | unsupported`.

| Level | When |
|---|---|
| `unsupported` | No card products and no configured campaign source |
| `coming` | No card products, but an official campaign source is configured (crawler disabled) |
| `profile_only` | Products exist, but no campaign crawler and no core benefits |
| `full` | Every facet is `full` **and** the sources are `verified` |
| `partial` | Anything else |

**Source freshness** is `verified | last_known | stale | unverified`:

| Freshness | When |
|---|---|
| `verified` | Last success ≤ 2 days ago and the last run produced fresh records |
| `last_known` | ≤ 7 days, or the source was repaired from the last known good catalog (LKG) |
| `stale` | Older than that |
| `unverified` | Never succeeded, or disabled |

**Criteria freshness** is `verified` (≤ 90 days), `stale`, or `unverified` (no `verified_at`). Source verification is global. It is separate from a user's own confirmation (`criteria_version` + `confirmed_at`).

**Rules enforced by tests:**

- The declared `campaigns` value is an **upper bound**. A bank without an enabled crawler (enabled + adapter in the registry) can never show `full` or `partial` campaign coverage.
- With no registry loaded, a bank shows at most `partial`.
- A bank with no products always has `cardProducts: none`.
- No bank is `full` in v1.5.0.

**UX**

- *Bank picker*: a short badge only when support isn't complete ("Kısmi destek", "Kampanyalar yakında", "Henüz desteklenmiyor"). A card-less bank says "Kart listesi hazırlanıyor".
- *Hangi Kart?*: one line, only when a selected bank cannot contribute yet (coming / unsupported / profile_only). Partial support stays quiet in the normal flow.
- *Profil › Uygulama Bilgisi*: a per-bank table with status, cards, benefits, campaigns, crawler freshness and last successful crawl.

A user may select a card-less bank and complete onboarding with it. Hangi Kart? still ranks only owned, defined cards.

## 3. Central campaign source registry

- **Configuration** (reviewed in git): `server/source_catalog.json`. Each row has `key` (source_code), `bank`, `bank_code`, `source_type`, `adapter`, `enabled`, `cadence`, `priority`, `listing_urls`, … The new banks' official pages are registered with `"enabled": false` and `"adapter": null`. They are **never fetched**: the crawler's `load_config()` returns active sources only, and the guard judges health for active sources only.
- **Runtime state** is published with every catalog in `meta.sourceRegistry`. Each row has `sourceCode`, `bankCode`, `url`, `sourceType`, `adapter`, `enabled`, `cadence`, `priority`, `lastCrawlAt`, `lastSuccessAt`, `lastVerifiedAt`, `freshCount`, `health` and `sourceVerifiedAt`. The crawler sets `ok` or `zero`; the guard upgrades to `severe_drop` or `repaired_from_lkg` (keeping the previous `lastSuccessAt`).
- **Single source of truth.** There is no duplicate DB table for the registry: config lives in git, runtime state in the published snapshot.
- **Crawling stays global and central**, on the existing twice-daily schedule. Selecting a bank never triggers or configures a crawl. The flow is unchanged: official source → crawler → structured catalog → quality guard → snapshot → per-user eligibility.

### 3a. Crawl first, personalize after (replacement build)

- **Discovery is global.** Its only inputs are the reviewed source rows and the official pages/APIs. Source rows no longer carry `card_products`; no user, profile, owned card, segment or product list participates. Tests run the real pipeline twice (with and without "user" state) and require identical output.
- **Source ≠ card eligibility.** Each campaign's cards come from the campaign itself (`server/card_eligibility.py` + the reviewed vocabulary `server/card_families.v1.json`):
  1. official structured data (Wings API `card_type`), else
  2. the campaign's own title and terms text (sentence-length lines only; page chrome is ignored), or
  3. a per-URL verified override (`VERIFIED_CARD_OVERRIDES`).
- **Family / program scope.** Campaign wording such as "TEB Bonus özellikli bireysel kredi kartları" or "Miles&Smiles QNB Kredi Kartı" resolves to a stable **family code** (`cardFamilies`), not to the single product that happens to exist today.
  - Families are master data (`CARD_ELIGIBILITY_FAMILIES`: code, bank, label, `members`, `membershipComplete`). They are versioned in code and published in `eligibility_master.v1.json`. There is no new table, so no migration.
  - All current families are `membershipComplete: false`, so such campaigns are `partial`.
  - The v1 rule is `{payWith:{families:[…]}}`. A new member product is added to `members` only; campaign records don't change.
  - Explicitly named products (e.g. "Miles&Smiles QNB Private") stay product-level (`cardProductIds`).
- **`eligibilityResolution`** on every record:
  - `state`: `resolved | partial | unresolved | needs_review`;
  - `method`, `cardProductIds` (explicit products), `cardFamilies` (family scope), `excludedProducts` / `excludedFamilies`, `families` (evidence), `excluded`, `unmappedTokens`, `segment`, `reasons`.
- **Only canonical products ever appear.** Free text never creates products. `unresolved` / `needs_review` records keep `cardProductIds: []`: they stay in the catalog and diagnostics but are never applicable (the JS evaluator also fails closed on these states).
- **Page kinds:** `campaign_detail | category_listing | program_listing | navigation | unknown`. Only details enter the catalog. Hubs are rejected by `hub_slugs` and, independently, by structure: several campaign links and no legal text.
- **LKG records** written before this model are re-resolved from their own text before reuse. This happens both in the crawler's stale paths and in the guard's repair; verified URLs keep their mapping, and invalid v1 records are still dropped rather than "sanitised".

### 3b. Source completeness metrics

The crawler writes these per source to `meta.source_reports` and `meta.sourceRegistry[].metrics`:

- `mechanism`;
- `listing_candidates`, `sitemap_candidates`, `discovered_detail_urls`, `truncated`, `fetched`, `fetch_errors`;
- `active`, `applicable`, `resolved`, `partial`, `unresolved`, `needs_review`;
- `expired`, `rejected_page_kinds`, `parse_errors`;
- `official_count` / `official_active_count`, only when the bank publishes an enumerable count;
- `completeness {status, confidence, reasons}`.

**Status values:**

- **`complete` / high:** only when the official count was fully enumerated and parsed.
- **`incomplete`:** five or more candidate detail pages that yield fewer than half as many campaigns (e.g. "25 candidates, 1 record"). The source's registry `health` becomes `incomplete`.
- Equality with the LKG catalog is never evidence of completeness. The guard lists `incompleteSources` and prints a per-source table in the Actions summary.

## 4. "Bankam listede yok" (unsupported-bank requests)

- **Table** `bank_support_requests` (migration 012). It has `id`, `user_id` (defaults to `auth.uid()`), `requested_name`, an optional `note`, `created_at`, and `normalized_key`.
  - `normalized_key` is a **generated column**: Turkish letters folded, non-alphanumerics → `-`, trailing "bank/bankası/A.Ş." removed. "ING Bank" and "İNG BANKASI" both give `ing`.
  - `unique (user_id, normalized_key)`: one row per user and bank.
- **RLS:** a user can select, insert and delete only their own rows. There is no anon access, and a user cannot insert a row for another user.
- **Never touches canonical data.** No bank, product or campaign is created, and the canonical tables are unchanged (tested in SQL and in the browser).
- **Aggregation:** the `bank_support_request_summary` view (`security_invoker`) is readable only by `service_role`. It returns `normalized_key`, `request_count`, first/last requested time, latest name, and `matches_existing_bank`.
- **Client:** a "Bankam listede yok" link in the bank lists. The request body is `{user_id, requested_name}` only. The JS normalizer matches the DB generated column, which a test checks.

## 5. ACTUAL vs HYPOTHETICAL (`web/opportunity.js`, no UI)

- **ACTUAL_PROFILE** is what Hangi Kart? uses: the persisted profile, owned cards only, and only currently confirmed attributes.
- **HYPOTHETICAL_PROFILE** comes from `buildHypotheticalProfile(actual, {addCards, attributes})`. It is a deep copy marked `hypothetical`, its attribute stamps are not user confirmations, and it is never saved.
- **`evaluateOpportunity(...)`** returns `actual`, `hypothetical`, `potentialReward`, `delta`, `missingRequirements` (bank / card / attribute) and `qualificationClaimed: false`.
- **Tests confirm:**
  - the input profile and the normal Hangi Kart? output are unchanged;
  - a temporarily added card is evaluated;
  - an attribute-only overlay returns the tier delta;
  - `app.js` does not use this module.

## 6. Expand / contract status

- **v1.5.0 (expand):**
  - adds tables (`card_programs`, `bank_coverage`, `bank_support_requests`), a nullable column (`card_products.program_code`), bank rows and display-label updates;
  - dual-writes the catalog.
  - Nothing is renamed or dropped. A cached v1.4.4 client keeps working: it ignores the new tables and columns, and new banks appear to it as card-less banks.
- **Contract (later release, once v1.4.x can no longer be active):**
  - stop writing legacy `segmentLabels` / `segmentRules` for campaigns that have v1 fields;
  - retire `engine_label` threshold keys (Wings);
  - remove `legacy-option-aliases.js` once no old snapshot or device data remains.
