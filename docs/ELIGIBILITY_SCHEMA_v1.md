# Campaign eligibility schema v1 — FROZEN for v1.5 dual-write

Status (v1.4.3; schema v1 unchanged since v1.4.2):

- **Implemented and tested:** the evaluator, schema-version enforcement, structural validation, the catalog quality guard validator, and the `rewardVariants` selection semantics.
- **Shared:** the evaluator (`web/eligibility.js`) is used by both *Kampanyalar* and *Hangi Kart?*. The validator exists in JS and Python (`server/eligibility_schema.py`), and both are run against one shared fixture (`docs/eligibility-validation-cases.v1.json`).
- **Not implemented yet (v1.5):**
  - the crawler emitting rules (dual-write);
  - wiring `rewardVariants` into the Hangi Kart? amount;
  - migrating `bootstrap-data.js` core benefits.
- **No live effect yet:** no published catalog entry uses `eligibilityRule` today. Every campaign goes through the legacy adapter, and results are identical to v1.4.0/v1.4.1. A test checks 616 combinations, and another checks that the bundled catalog is 100% legacy.

The campaign truth stays on the existing path: **crawler → catalog JSON → quality guard → catalog snapshot → client**. The relational `campaigns` tables stay unused.

## 1. Fields (catalog JSON, per campaign)

```jsonc
{
  "id": "…",
  "eligibilitySchemaVersion": 1,                 // REQUIRED whenever eligibilityRule or rewardVariants is present
  "eligibilityRule": { /* rule node */ },        // card/profile eligibility only
  "rewardVariants": [                            // reward tier selection only (separate decision)
    { "when": { /* rule node */ }, "rewardRule": { … }, "periodCap": 2000 }
  ],
  // legacy fields, still written during dual-write and read ONLY when no new-schema key exists:
  "cardProductIds": ["…"], "eligibility": { "segmentLabels": ["…"] }, "segmentRules": { … }
}
```

## 2. Schema version enforcement (fail closed)

A record **uses the new schema** if it has an `eligibilityRule` **or** a `rewardVariants` key. This holds even when the value is `null`. The crawler omits a key it has no value for; it never writes `null`.

| Record | Client (`resolveCampaignEligibility`) | Quality guard (`validate_campaign`) |
|---|---|---|
| No new-schema key | `legacy`: the adapter builds the rule from `cardProductIds` + `segmentLabels` | `legacy`: published as today |
| New-schema key + `eligibilitySchemaVersion` is the **integer 1** + valid rule/variants | `valid`: `eligibilityRule` alone decides | `valid`: published |
| New-schema key + version **missing**, **malformed** (`"1"`, `1.5`, `true`, `null`) or **unsupported** (`0`, `2`, …) | `invalid` → **not eligible for any card** (`unsupported_schema`) | **rejected** |
| New-schema key + valid version + **malformed** rule/variant | `invalid` → not eligible (`invalid_rule`) | **rejected** |
| `eligibilitySchemaVersion` present with no new-schema key | `legacy` (the version is ignored) | `legacy` |

Rules:

- **No silent interpretation.** If the version is not supported, the rule content is not read at all.
- **No legacy fallback.** An invalid new-schema record is never re-read through `cardProductIds` / `segmentLabels`, even when those would match. The shared fixture gives every invalid case legacy fields that *would* match, to prove this.
- **Defense in depth.**
  - *Client:* an invalid record is not a candidate in Hangi Kart? (`campaignTargetsCard` → false), it is not listed in Kampanyalar, and `evaluateCampaignForCard` returns a definite `false` with a reason.
  - *Quality guard:* the record is never published.
- **What each side checks:**
  - *Client:* checks **structure** only (it has no master data at runtime).
  - *Guard:* additionally checks codes against `server/eligibility_master.v1.json`. That file is generated from `web/profile-catalog.js`, which is the migration 008/009 seed, and parity tests run in both JS and Python.
    - **Unknown dimension / option → error** (the rule can never be satisfied; almost surely a typo).
    - **Unknown card product / bank → warning** (a product not yet in the master data, e.g. `qnb-fix`; it can't match any user, so it is inert).
  - Published rules may **not** use `legacySegmentLabel`. Only the adapter generates it.

### Quality guard behaviour (LKG preserved)

`catalog_guard.py evaluate` validates the records **before** it measures source health:

1. Invalid records in the **LKG** are dropped. They are never restored or re-published. This includes the "rejected → redeploy LKG" path.
2. An invalid **fresh** record is dropped. If the LKG has a valid, unexpired record with the same `id` (or `sourceUrl`), that record is kept, marked `staleFromLastKnownGood`, with a warning. Otherwise the campaign is simply not published.
3. A source whose rules **all** broke has zero fresh records. That counts as a degraded source, so the existing per-source LKG repair applies. If too much broke, the existing total/majority thresholds reject the whole crawl and keep the LKG.
4. If anything was dropped, the verdict becomes `repaired`. The report lists `invalidEligibility` (id, source, errors, `restoredFromLkg`), `lkgInvalidEligibility` and `eligibilityWarnings`. These also appear in the GitHub step summary.
5. Bootstrap (no LKG): invalid records are dropped. Nothing is restored.

## 3. Rule nodes

Each node is an object with **exactly one** key. All values are stable master-data codes. Turkish display labels are rejected.

| Node | Meaning |
|---|---|
| `{ "all": [r, …] }` | AND (non-empty) |
| `{ "any": [r, …] }` | OR (non-empty) |
| `{ "not": r }` | NOT / exclusion |
| `{ "payWith": { "cards": [codes], "banks": [codes] } }` | Transaction level: the card **used for this transaction**. |
| `{ "owns": { "cards": [codes], "banks": [codes] } }` | Customer level: the user **holds** one of the products / is a customer of one of the banks (from the profile). |
| `{ "attr": { "dim": code, "in": [option codes] } }` | Profile attribute. Reads `user_profile_attributes` by dimension and option code. Never reads `card.segment`. |
| `{ "always": true }` | Unconditional. Used as the guaranteed fallback in `rewardVariants`. |
| `{ "legacySegmentLabel": { "in": [labels] } }` | **Adapter-internal only.** Rejected in published rules. |

`payWith`, `owns` and `attr` accept no other keys. A typo such as `"card"` or an extra `"segment"` is an error.

### Mixed `cards` + `banks` in one leaf is conjunctive (AND)

- **`payWith: { cards: C, banks: B }`:** the transaction card must be in C **and** belong to a bank in B. Example: `{cards:["teb-infinite"], banks:["qnb"]}` can never be true.
- **`owns: { cards: C, banks: B }`:** the user holds *some* product in C **and** is a customer of *some* bank in B. These need not be the same card.
- **For OR**, use separate nodes under `any`:

  ```json
  { "any": [ { "payWith": { "cards": ["teb-infinite"] } }, { "payWith": { "banks": ["qnb"] } } ] }
  ```

Regression tests: `test-eligibility.mjs` §8.

### Three-valued logic

The values are `true`, `false` and `null` (unknown).

- `attr` is `null` when the dimension is not selected ("Bilmiyorum").
- `all`: `false` if any child is false, else `null` if any child is null, else `true`.
- `any`: `true` if any child is true, else `null` if any child is null, else `false`.
- `not(null) = null`.
- **Eligible ⇔ `true`.**

Results carry reasons: `card_product`, `segment` (+`dim`), `ownership`, `excluded`, `invalid_rule`, `unsupported_schema`. Evaluation is a pure function of the rule, the context and the card. `campaignTargetsCard` (the Hangi Kart? candidate pre-filter) evaluates only `payWith` leaves. It returns false for invalid records.

## 4. `rewardVariants` — three-valued tier selection (defined and tested; not yet wired to the amount)

Eligibility and reward tier are **separate decisions**:

1. The campaign must be eligible (`eligibilityRule` is `true`).
2. Only then is a tier selected.

Variants are evaluated **in order**. The author lists the most specific / most valuable tier first.

| `when` evaluates to | Effect |
|---|---|
| `true` | This is the **ACTUAL** variant. Scanning stops; the first true variant wins. |
| `false` | Skipped. |
| `null` (unknown) | **Not** counted as actual. Recorded as **CONDITIONAL** (potential) information with its reasons; scanning continues. |

- **Unknown never inflates the normal amount.** The Hangi Kart? amount may use only `actual`.
- **The guaranteed floor must be explicit.** It comes only from an explicit `{ "always": true }` variant (or another definitely-true one).
- **No implicit fallback.** When `rewardVariants` is present, the campaign's base `rewardRule` is **not** a fallback. It remains for legacy clients only. If nothing is true, there is no actual reward (`status: 'conditional_only'` or `'none'`). This prevents today's QNB problem, where the base rule is really the top tier.
- **Variants after the actual one are ignored.** Null variants that come *after* the actual variant are not reported as conditional.

`resolveCampaignReward(campaign, card, ctx)` returns:

| Status | Meaning |
|---|---|
| `ineligible` | Eligibility is `false`, or the record is invalid. No actual reward, no conditional info. |
| `eligibility_unknown` | Eligibility is `null`. No actual reward. All non-false variants are conditional only. Example: TEB core benefit with the tier not selected. |
| `actual` | Eligible, with an actual variant. Higher unknown tiers appear in `conditional`. |
| `conditional_only` / `none` | Eligible, but no variant is true. |
| `legacy` | No `rewardVariants`. The existing engine (`rewardRule` / `segmentRules`) decides. |

**QNB Terminal Kadıköy** (eligibility: any QNB card; tiers: Private 20%, First Plus 15%, `always` 10%):

| QNB segment | Actual | Conditional |
|---|---|---|
| `private` | 20% | — |
| `first_plus` | 15% | — |
| `first` / `other` | 10% | — |
| not selected | **10% (guaranteed)** | 20%, 15% |
| paying with a non-QNB card | — (`ineligible`) | — |

## 5. Actual vs hypothetical context

- **ACTUAL** (`mode: 'actual'`, the default from `buildEligibilityContext`): the user's persisted profile and the cards they actually own. Normal **Hangi Kart?** uses only this. Unknown attributes create no definite benefit.
- **HYPOTHETICAL** (future *Discovery*, not implemented): `withHypotheticalOverlay(ctx, { cards, banks, attributes })` returns a **new** context with `mode: 'hypothetical'` and an `overlay` record.
  - It reuses the same rule system and evaluator.
  - It never mutates the input context or the persisted profile, and it is never saved.
  - Tests check the following: the overlay makes a Private-only campaign eligible; the actual context still returns `null`; the profile JSON is byte-identical; `app.js` does not use the overlay.
- **Discovery rules (for when it is built):**
  - results are labelled hypothetical;
  - hypothetical amounts are never merged into the actual Hangi Kart? ranking;
  - `payWith` may name a card the user doesn't own only in hypothetical mode.

## 6. Canonical segment identity and dated criteria (implemented in v1.4.3)

Each dimension option has separate layers:

| Layer | Example | Stability | Where it lives |
|---|---|---|---|
| **Option code** | `maximiles_band.band_2` | Frozen forever; opaque; scoped by dimension | rules, `user_profile_attributes`, guard master file |
| **Neutral option name** | "2. bant" | Can be reworded | `profile_dimension_options.label` (fallback only) |
| **Criteria (versioned)** | v1: "1–4 milyon TL arası", 1,000,000–4,000,000 TRY | **Volatile, dated, source-backed** | `profile_option_criteria` (migration 010) = `PROFILE_OPTION_CRITERIA` in `web/profile-catalog.js` |
| `engineLabel` | `band_2` (asset bands) | Engine key for legacy `segmentRules` | profile catalog |

- **Asset bands are renamed.** `maximiles_band` and `crystal_band` use `band_1`…`band_4`.
  - `band_2` does **not** mean the same amount in both programs: Maximiles v1 band_2 is 1–4M; Crystal v1 band_2 is 1–6M.
  - No option code anywhere embeds a threshold, and a test enforces this for every dimension.
- **A criteria row** carries: dimension code, option code, `criteria_version`, `effective_from`, `effective_to` (exclusive; null = in force), display label, lower/upper bound (TRY, informational), bound unit, source URL, source reference (verbatim wording), and `verified_at`.
  - `verified_at` is null when the source couldn't be verified (the UI then says "yeniden doğrulanmadı"). Both programs are currently verified on 2026-10-03:
    - **Maximiles v1:** the official Maximiles Black restaurant campaign page.
    - **Crystal v1:** the official Crystal Card page ([Varlığa Bağlı Crystal Ayrıcalıkları – restaurant/hotel discounts](https://www.crystalcard.com.tr/crystal-dunyasi/varliga-bagli-crystal-ayricaliklari/crystal-ile-yurt-disi-yurt-ici-tum-restoranlarda-5-indirim)). It publishes the four bands "1 milyon TL'nin altında / 1 milyon TL - 6 milyon TL arasında / 6 milyon TL - 10 milyon TL arasında / 10 milyon TL ve üzerinde", each with its per-transaction and monthly limit (1.500/3.000, 2.500/5.000, 3.000/7.500, 4.000/10.000 TL for the 20% partner restaurant/hotel discount). Those limits are identical to the app's Crystal campaign rules, and a test checks this.
  - Crystal was previously cited to a JS-rendered Yapı Kredi page with `verified_at` null. The corrected `010_option_criteria.sql` writes the new source with `ON CONFLICT DO UPDATE`, so re-running it on a database that already ran the earlier 010 corrects the rows. No new migration is needed, because 010 has not been applied to production yet.
  - Maximiles v1 was verified on 2026-10-03 against the official campaign page.
  - The same page's history shows why this matters: the bank used two bands at 500,000 TL in Q1 2025 and four bands from 1,000,000 TL in Q4 2026.
- **The user's asset amount is never asked for or stored.** Campaign Hunter never computes band membership from an amount; the user picks the band, and the bounds only help them choose.

### Source verification ≠ user confirmation (two separate concepts)

| | **Source verification** (global master data) | **User confirmation** (personal profile) |
|---|---|---|
| Describes | How confident and fresh *our copy* of a bank's published criteria is | When *this user* said their own band is X, and under which criteria version |
| Stored in | `profile_option_criteria.verified_at`, `source_url`, `source_reference` | `user_profile_attributes.criteria_version`, `confirmed_at` |
| Changed by | Checking the official source (maintainer / crawler / migration) | The user picking or reconfirming a band |
| Scope | Same for everyone | Per user |

- A user confirmation never implies that the source was verified, and a verified source never confirms anyone's choice. Tests check both directions.
- Today the engine uses only the user-confirmation status (below). `verified_at` is shown as provenance ("doğrulandı 2026-10-03" / "yeniden doğrulanmadı").
- **Forward requirement (bank coverage model, not implemented here):** global criteria and source state will need explicit coverage/freshness semantics, e.g. **verified** (checked within the freshness window), **last-known** (previously verified, recent check failed or source unreachable), **stale** (past its freshness window or the source period ended), **unverified** (never matched to an official source). These states apply to the master data. They must not be inferred from, or fold into, user confirmation.

### Confirmation and reconfirmation

- **What is stored.** `user_profile_attributes` keeps `option_code`, `criteria_version` (the version the selection was confirmed under) and `confirmed_at`. A foreign key ensures that the version exists for that option.
- **Status values.** For a selection, `profile-criteria.js` computes one of:

| Status | Meaning | Used by Hangi Kart? / eligibility |
|---|---|---|
| `not_versioned` | Dimension has no criteria rows (e.g. `teb_tier`) | yes |
| `confirmed` | Confirmed under today's version | yes |
| `unconfirmed` | No version recorded | **no** (treated as unknown), prompt |
| `stale` | Confirmed under an older version, or the option is undefined in today's version | **no** (treated as unknown), prompt |
| `criteria_unavailable` | No version in force today, or overlapping versions | **no** (treated as unknown) |

- **When the bank changes thresholds:**
  1. Add version v2 rows.
  2. Set v1's `effective_to`.
  3. Leave codes and user rows unchanged.

  On the effective day (Europe/Istanbul), a user's `band_2@v1` becomes `stale`. The persisted selection is kept (so reconfirming is one click: "Evet, …"), but it never silently counts as current truth.
- **When a confirmation is written:**
  - Onboarding confirms only never-confirmed selections that the user saw on the review screen. It never renews a stale one.
  - Explicit reconfirmation (`confirmAttribute`) writes the current version.
- **Legacy mode** (no account) has no confirmation tracking. It is the pre-v1.4 fallback.

### Migration of old identifiers

- **One translation point.** Old threshold-coded IDs are translated in exactly one client module (`web/legacy-option-aliases.js`) and one server migration (`010_option_criteria.sql`). The client module handles device settings, v1.4.x profile caches, and published catalog records whose `segmentLabels` / `segmentRules` are still keyed by the old band labels.
- **Migrated selections count as confirmed under v1.** They were chosen while seeing labels with v1's thresholds. Server rows get `confirmed_at` = the row's last update; device data gets `null`.
- **Allowed occurrences.** A test fails if an old ID appears anywhere else. The only allowed places are:
  - the alias module;
  - migration 010;
  - the immutable history migrations 004/005, which 010 converts, and the one-shot script that contains them;
  - tests that simulate old data;
  - historical audit docs.
- **Final database state.** In both the fresh and the upgrade path, the database has no old code in any option row, attribute row, constraint or column default. This is checked in real PostgreSQL.
- **Reward equivalence.** Results are equivalent before and after the rename, checked against a fixture generated with the v1.4.2 engine:
  - 672 campaign scenarios (bands × card types × dates × amounts);
  - 48 MaxiMil earning scenarios;
  - the 4 crawler overrides.
- **Removal plan.** The alias module can be removed one stable release after no published snapshot or active device carries old keys.

### Deferred to v1.5 / master-data migration: Wings and TEB labels

- **Why they wait.** The Wings and TEB display labels ("Black Plus / 2 milyon TL+", "Ultra / 10 milyon TL+") and the Wings `engineLabel`s still contain thresholds. Their **canonical codes** are already stable named tiers (`standard`/`black`/`black_plus`, `standard`/`plus`/`premium`/`ultra`), so identity is not affected. They are deliberately left unchanged until the `rewardVariants` / master-data migration.
- **What that migration should do:**
  - use clean named-tier labels ("Black Plus", "Ultra");
  - keep volatile qualification thresholds outside canonical identity;
  - add threshold criteria rows only where an appropriate official source supports them (same `profile_option_criteria` mechanism). Otherwise show the tier name with no threshold;
  - move the Wings `engineLabel`s together with the `segmentRules` → `rewardVariants` migration.

## 7. Migration plan (v1.5)

1. **Crawler dual-write.** The crawler writes `eligibilitySchemaVersion: 1` + `eligibilityRule` **alongside** the legacy fields.
   - The default rule per source is `payWith.cards` from `source_catalog.json`.
   - `special_overrides` express segments as `attr`, exclusions as `not`, and tiers as `rewardVariants` with an explicit `always` floor.
2. **Guard.** The guard validates the new fields (already in place). The client prefers valid new rules. An invalid rule fails closed, with no legacy fallback.
3. **Wire `rewardVariants` into the engine.** Use `resolveCampaignReward`: the Hangi Kart? amount uses `actual` only, and `conditional` becomes a "segmentini seçersen %20 olabilir" hint. Add equivalence tests against `segmentRules` for the `bootstrap-data.js` core benefits.
4. **Retire the legacy fields.** After one stable release, the legacy fields stop being written. The adapter stays for old snapshots. `engineLabel` is retired together with `segmentRules`.

### Deployment practice for public releases (forward requirement)

Once the app is public, schema and data migrations must follow **backward-compatible expand/contract**, so that a still-cached previous PWA client is not broken by the deploy:

1. **Expand.** Add new tables, columns, option codes or criteria versions alongside the old ones. Old clients keep working; new clients use the new shape. Don't rename, drop or re-key anything that the previous client still reads or writes in this step.
2. **Migrate.** Backfill and dual-write (crawler and catalog) until the previous client version is no longer served. The service worker cache name includes the build id, so updates roll out on the next load, but an installed PWA may run the old bundle for a while.
3. **Contract.** Remove old codes, columns or keys only in a later release, after the previous client can no longer be active.

Migration 010 does *not* follow this, because v1.4.3 is pre-public and the profile tables hold no production user data: it renames option codes and re-keys catalog `segmentRules` in one step. This is accepted for the current acceptance run only. Every future public release must use expand/contract.

Adding schema version 2 later means adding it to `SUPPORTED_ELIGIBILITY_SCHEMA_VERSIONS` / `SUPPORTED_VERSIONS` in the client **before** the crawler emits it. Older clients then fail closed on v2 records; they never misread them.

## 8. Examples

Machine-checked by `web/test-eligibility.mjs` (eligibility + reward variants) and `server/tests/test_eligibility_schema.py` (validity). See `docs/eligibility-examples.v1.json`.

1. **TEB Infinite otel/restoran (core):** `all[payWith teb-infinite, attr teb_tier ∈ {standard, plus, premium, ultra}]` + tier variants.
   - premium → actual 15%;
   - tier not selected → `eligibility_unknown`, with all four tiers conditional.
2. **Maximiles Black restoran Q4:** `all[payWith is-maximiles-black, attr maximiles_band ∈ {band_1…band_4}]` + band variants.
3. **QNB Terminal Kadıköy:** `payWith banks [qnb]`; variants private 20% → first_plus 15% → `always` 10% (table in §4).
4. **QNB şarj ParaPuan, Miles&Smiles QNB excluded:** `all[payWith banks [qnb], not payWith cards [qnb-ms-private]]`.
5. **TEB Ultra-only:** `all[payWith teb-infinite, attr teb_tier = ultra]`.
6. **Axess genel, Wings included:** `any[payWith akbank-wings-elite, payWith akbank-wings-black]`.

## 9. Master data scope

Only the original six card products exist: Wings Elite, Wings Black, Maximiles Black, Miles&Smiles QNB Private, TEB Özel Infinite and Crystal. Expanding the catalog is a separate, controlled step: master data + migration seed + `eligibility_master.v1.json` + crawler mapping + criteria rows (§6).
