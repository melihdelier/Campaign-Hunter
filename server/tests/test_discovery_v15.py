"""v1.5.0 — crawl first, personalize after.

The real crawler pipeline runs offline against reviewed fixtures (discovery_fixture_run.py):
  * discovery and the crawled catalog are identical whatever user / card / segment configuration exists;
  * the source never implies card eligibility; unknown/unowned-card campaigns stay in the catalog;
  * Wings uses the official JSON API with an enumerable official count;
  * hubs (MercedesCard Kampanyaları, Giyim&Aksesuar Kampanyaları, Taksitlendirme&Erteleme) are never campaigns;
  * TEB general discovery comes from the authoritative sitemap (no manual fallback list);
  * completeness metrics: LKG equality is never evidence of completeness.
"""
import copy
import json
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("CATALOG_GUARD_ACTIONS_REPORTING", "0")
import discovery_fixture_run as fx  # noqa: E402
import campaign_crawler as cc  # noqa: E402
import card_eligibility as ce  # noqa: E402
import catalog_guard as cg  # noqa: E402
import source_registry  # noqa: E402

GIYIM_FIXTURE = HERE.parents[1] / "web" / "fixtures" / "giyim-regression.v1.json"


def by_title(payload, needle):
    hits = [c for c in payload["campaigns"] if needle.lower() in c["title"].lower()]
    return hits[0] if hits else None


class CrawlFirstTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import io, contextlib
        with contextlib.redirect_stdout(io.StringIO()):
            cls.payload = fx.run_pipeline(fx.fixture_sources())
            # Same crawl, but with "user" state everywhere a careless implementation could read it: per-source card lists,
            # env vars naming a user / owned cards / segment. Output must be byte-identical (minus timestamps).
            cls.payload_user = fx.run_pipeline(
                fx.fixture_sources({"card_products": ["is-maximiles-black"], "owned_cards": ["teb-infinite"]}),
                env={"CAMPAIGN_HUNTER_USER": "u-123", "OWNED_CARDS": "akbank-wings-black", "USER_SEGMENT": "ultra"})
        cls.reports = {r["key"]: r for r in cls.payload["meta"]["source_reports"]}

    # ---------------------------------------------------------------- independence from the user
    def test_crawler_output_identical_regardless_of_user_or_card_selection(self):
        self.assertEqual(fx.stable_campaigns(self.payload), fx.stable_campaigns(self.payload_user))
        a = [{k: v for k, v in r.items()} for r in self.payload["meta"]["source_reports"]]
        b = [{k: v for k, v in r.items()} for r in self.payload_user["meta"]["source_reports"]]
        self.assertEqual(a, b)

    def test_discovery_identical_for_any_card_configuration(self):
        import io, contextlib
        for extra in ({}, {"card_products": []}, {"card_products": ["qnb-ms-private", "ykb-crystal"]}):
            with contextlib.redirect_stdout(io.StringIO()):
                from unittest.mock import patch
                with patch.object(cc, "fetch", side_effect=fx.fake_fetch):
                    got = [cc.discover({**s, **extra}, fx.TODAY)["urls"] for s in fx.fixture_sources()]
            if extra == {}:
                base = got
            self.assertEqual(got, base)

    def test_crawler_code_has_no_user_or_source_card_inputs(self):
        src = (HERE.parent / "campaign_crawler.py").read_text(encoding="utf-8")
        self.assertNotIn('source["card_products"]', src)
        self.assertNotIn("source['card_products']", src)
        self.assertNotIn('"card_products"', src)
        for forbidden in ("user_cards", "user_profiles", "profile-store", "owned_cards", "SUPABASE"):
            self.assertNotIn(forbidden, src)
        cfg = json.loads((HERE.parent / "source_catalog.json").read_text(encoding="utf-8"))
        self.assertFalse(any("card_products" in s for s in cfg), "source rows must not carry card lists")

    # ---------------------------------------------------------------- eligibility is per campaign
    def test_unknown_and_unowned_card_campaigns_remain_in_catalog(self):
        unknown = by_title(self.payload, "Kitap Alışverişlerinize")
        self.assertIsNotNone(unknown)
        self.assertEqual(unknown["eligibilityResolution"]["state"], "unresolved")
        self.assertEqual(unknown["cardProductIds"], [])
        self.assertNotIn("eligibilityRule", unknown)  # no v1 rule → applicable to nobody (legacy payWith [] = false)
        merc = by_title(self.payload, "MercedesCard'a Özel")
        self.assertIsNotNone(merc)
        self.assertEqual(merc["cardProductIds"], [])  # never Maximiles Black
        self.assertIn("mercedescard", [f["code"] for f in merc["eligibilityResolution"]["families"]])
        wings_classic = by_title(self.payload, "Wings Kampanya 3")
        self.assertEqual(wings_classic["eligibilityResolution"]["state"], "partial")
        self.assertEqual(wings_classic["cardProductIds"], [])

    def test_no_campaign_has_cards_without_evidence(self):
        for c in self.payload["campaigns"]:
            res = c["eligibilityResolution"]
            self.assertIn(res["state"], ce.STATES)
            self.assertEqual(c["cardProductIds"], res["cardProductIds"])
            self.assertEqual(c.get("cardFamilies", []), res.get("cardFamilies", []))
            if c["cardProductIds"] or c.get("cardFamilies"):
                self.assertIn(res["method"], ("official_api", "terms_text", "verified_override"))

    def test_wings_card_type_tokens_map_only_to_canonical_products(self):
        six = by_title(self.payload, "Wings Kampanya 6")
        self.assertEqual(six["cardProductIds"], ["akbank-wings-black"])
        zero = by_title(self.payload, "Wings Kampanya 0")
        self.assertEqual(zero["title"], "Wings Kampanya 0'de 500 TL'ye Varan Chip-Para!")  # &nbsp; stripped
        self.assertEqual(sorted(zero["cardProductIds"]), ["akbank-wings-black", "akbank-wings-elite"])
        self.assertEqual(zero["eligibilityResolution"]["method"], "official_api")
        self.assertEqual(zero["categories"], ["giyim"])  # official sector → category
        no_token = by_title(self.payload, "Wings Kampanya 4")
        self.assertEqual(no_token["eligibilityResolution"]["method"], "terms_text")

    # ---------------------------------------------------------------- Wings discovery
    def test_wings_uses_official_api_with_enumerable_count(self):
        r = self.reports["wings"]
        self.assertIn("json_api", r["mechanism"])
        self.assertEqual(r["official_count"], 10)
        self.assertEqual(r["api_items"], 10)
        self.assertEqual(r["expired"], 1)
        self.assertEqual(r["official_active_count"], 9)
        self.assertEqual(r["api_parsed"], 9)
        self.assertEqual(r["completeness"]["status"], "complete")
        self.assertEqual(r["completeness"]["confidence"], "high")
        self.assertIsNone(by_title(self.payload, "Wings Kampanya 5"))  # expired never enters

    def test_many_candidates_one_record_is_not_healthy(self):
        m = {"fetched": 25, "expired": 0, "fetch_errors": 0, "rejected_listing_pages": 0, "active": 1, "truncated": 0,
             "mechanism": "listing_html", "sitemap_candidates": 0, "official_count": None}
        comp = cc.assess_completeness(m, {})
        self.assertEqual(comp["status"], "incomplete")
        self.assertEqual(comp["confidence"], "low")
        rows = source_registry.build_registry([{"key": "wings", "bank_code": "akbank", "adapter": "x"}],
                                              [{"sourceKey": "wings"}], "2026-10-04T00:00:00Z", None,
                                              [{"key": "wings", "completeness": comp}])
        self.assertEqual(rows[0]["health"], "incomplete")

    def test_api_count_mismatch_is_partial_not_complete(self):
        m = {"fetched": 9, "expired": 0, "fetch_errors": 0, "rejected_listing_pages": 0, "active": 9, "truncated": 0,
             "mechanism": "json_api", "sitemap_candidates": 0, "official_count": 150, "api_items": 9,
             "official_active_count": 9, "api_parsed": 9}
        self.assertNotEqual(cc.assess_completeness(m, {})["status"], "complete")

    # ---------------------------------------------------------------- page kinds / hubs
    def test_maximiles_hubs_are_never_campaigns(self):
        src = next(s for s in fx.fixture_sources() if s["key"] == "maximiles")
        bare = {**src, "hub_slugs": []}  # structure alone must catch them
        for name, url, kind in (
            ("maximiles_hub_mercedescard.html", "https://www.maximiles.com.tr/kampanyalar/mercedescard-kampanyalari", "program_listing"),
            ("maximiles_hub_giyim.html", "https://www.maximiles.com.tr/kampanyalar/giyim-aksesuar", "category_listing"),
            ("maximiles_hub_taksit.html", "https://www.maximiles.com.tr/kampanyalar/taksitlendirme-ve-erteleme-firsatlari", "category_listing"),
        ):
            page = cc.parse_page((fx.FIX / name).read_bytes())
            self.assertEqual(cc.classify_page(bare, url, page), kind, name)
            rec, outcome = cc.parse_detail(bare, url, (fx.FIX / name).read_bytes(), fx.TODAY)
            self.assertIsNone(rec); self.assertTrue(outcome.startswith("page_kind:"))
        titles = [c["title"] for c in self.payload["campaigns"]]
        for hub in ("MercedesCard Kampanyaları", "Giyim&Aksesuar Kampanyaları", "Taksitlendirme&Erteleme"):
            self.assertNotIn(hub, titles)
        r = self.reports["maximiles"]
        self.assertEqual(r["rejected_page_kinds"].get("configured_hub_not_fetched"), 2)
        self.assertEqual(r["rejected_page_kinds"].get("category_listing"), 1)

    def test_detail_with_related_links_is_still_a_detail(self):
        page = cc.parse_page((fx.FIX / "maximiles_mercedescard_giyim.html").read_bytes())
        src = next(s for s in fx.fixture_sources() if s["key"] == "maximiles")
        self.assertEqual(cc.classify_page(src, "https://www.maximiles.com.tr/kampanyalar/x", page), "campaign_detail")

    # ---------------------------------------------------------------- TEB general
    def test_teb_general_discovers_from_authoritative_sitemap_not_fallbacks(self):
        cfg = next(s for s in cc.load_all_sources() if s["key"] == "teb_general")
        self.assertEqual(cfg["fallback_urls"], [])
        self.assertTrue(cfg["sitemap_urls"])
        r = self.reports["teb_general"]
        self.assertIn("sitemap", r["mechanism"])
        self.assertEqual(r["fallback_candidates"], 0)
        self.assertEqual(r["expired"], 1)
        self.assertEqual(r["rejected_page_kinds"].get("navigation"), 1)
        self.assertEqual(r["active"], 2)

    def test_teb_giyim_official_terms(self):
        """Official terms, 1–31 Oct 2026 (teb.com.tr/sizin-icin/giyim-alisveris/): Bonus-featured individual credit cards,
        Bonus-member giyim/aksesuar/kozmetik/ayakkabı merchants, each single 3.000 TL+ transaction → 120 TL Bonus,
        campaign max 1.200 TL, same day/merchant first only, enrollment first, domestic only, physical + virtual POS,
        Sade/debit/commercial excluded."""
        c = by_title(self.payload, "Giyim Alışverişlerinize Toplam 1.200 TL Bonus!")
        self.assertIsNotNone(c)
        self.assertEqual(c["sourceUrl"], "https://www.teb.com.tr/sizin-icin/giyim-alisveris")
        self.assertEqual(c["categories"], ["giyim"])
        self.assertEqual(c["rewardRule"], {"kind": "fixed", "minSpend": 3000.0, "reward": 120.0})
        self.assertEqual(c["periodCap"], 1200.0)
        self.assertNotIn("cumulativeSpendCampaign", c["transactionRules"])  # "Toplam 1.200 TL Bonus" is a reward total
        self.assertTrue(c["transactionRules"]["sameDaySameMerchantFirstOnly"])
        self.assertEqual(c["transactionRules"]["location"], "domestic")
        self.assertEqual(c["transactionRules"]["allowedChannels"], [])  # physical AND virtual POS / internet
        self.assertTrue(c["requiresEnrollment"])
        self.assertTrue(c["rulesComplete"])
        # Family scope: TEB Bonus-featured individual credit cards — not rewritten to teb-infinite, not every TEB card
        self.assertEqual(c["cardFamilies"], ["teb-bonus-individual-credit"])
        self.assertEqual(c["cardProductIds"], [])
        self.assertEqual(c["eligibilityResolution"]["state"], "partial")  # family membership incomplete in master data
        self.assertEqual(c["eligibilityRule"], {"payWith": {"families": ["teb-bonus-individual-credit"]}})
        self.assertIn("commercial", c["eligibilityResolution"]["excluded"])
        self.assertIsNone(c["eligibilityResolution"]["segment"])  # NOT Ultra-only (nav "Ultra" link is chrome)
        self.assertNotIn("eligibility", c)
        # Bonus-member merchants → merchant network, never unrestricted category-wide
        self.assertEqual(c["merchantScope"]["kind"], "restricted_unknown")
        self.assertEqual(c["merchantScope"]["scopeType"], "network")
        self.assertEqual(c["merchantScope"]["networkLabel"], "Bonus üye işyerleri")

    def test_retired_teb_url_redirecting_to_listing_is_not_a_campaign(self):
        stale = "https://www.teb.com.tr/sizin-icin/giyim-alisverislerinize-bonus"
        urls = [c["sourceUrl"] for c in self.payload["campaigns"]]
        self.assertNotIn(stale, urls)
        self.assertFalse(any("/sizin-icin/kampanyalar" in u for u in urls))
        self.assertEqual(self.reports["teb_general"]["rejected_page_kinds"].get("category_listing"), 1)
        # Directly: the redirect target (client-rendered listing) is a listing, not a detail / not a "too short" error
        src = next(s for s in cc.load_all_sources() if s["key"] == "teb_general")
        fr = fx.fake_fetch(stale + "/")
        self.assertNotEqual(cc.canonical_url(fr.url), stale)
        rec, outcome = cc.parse_detail(src, cc.canonical_url(fr.url), fr.body, fx.TODAY)
        self.assertIsNone(rec)
        self.assertEqual(outcome, "page_kind:category_listing")
        # The fixture router no longer maps the retired URL to a detail page
        self.assertNotIn(stale, fx.ROUTES)

    def test_merchant_network_vs_sector_scope(self):
        net = cc.detect_merchant_scope("Giyim Alışverişlerinize Toplam 1.200 TL Bonus!",
                                       "Bonus üyesi giyim, aksesuar, kozmetik ve ayakkabı işyerlerinde tek seferde yapacağınız harcamalar kampanyaya dahildir.",
                                       ["giyim"], "teb_general")
        self.assertEqual((net["kind"], net["scopeType"]), ("restricted_unknown", "network"))
        for txt in ("Kampanya üye işyerlerinde yapılan 1.000 TL ve üzeri harcamalarda geçerlidir ve sonra biter.",
                    "Kampanya anlaşmalı mağazalarda yapılan 1.000 TL ve üzeri harcamalarda geçerlidir ve sonra biter."):
            self.assertEqual(cc.detect_merchant_scope("Market Harcamalarınıza 100 TL", txt, ["market"], "x").get("scopeType"), "network", txt)
        # A plain sector/MCC condition (QNB giyim) stays category-wide; "aynı gün aynı üye işyeri" boilerplate is not a network
        qnb = cc.detect_merchant_scope("Giyim ve Kozmetik Alışverişinize 2.000'e Varan Mil Hediye!",
                                       "Miles&Smiles QNB Kredi Kartı ile giyim ve kozmetik sektöründe (üye işyeri sektör kodu giyim/kozmetik) yapılan alışverişler.\nAynı gün aynı üye işyerinde yapılan işlemlerden yalnızca ilki kampanya kapsamında ödül kazanır.",
                                       ["giyim"], "qnb_ms")
        self.assertEqual(qnb, {"kind": "all"})
        self.assertEqual(by_title(self.payload, "Giyim ve Kozmetik Alışverişinize 2.000")["merchantScope"], {"kind": "all"})

    def test_teb_ultra_only_only_when_terms_say_so(self):
        b = b"<html><h1>X Harcamalariniza %10</h1><p>Kampanya yaln\xc4\xb1zca TEB Ultra paket m\xc3\xbc\xc5\x9fterilerine \xc3\xb6zel olarak TEB \xc3\x96zel Infinite kredi kartlar\xc4\xb1 ile 1-31 Ekim 2026 tarihleri aras\xc4\xb1nda ge\xc3\xa7erlidir ve tek seferde 1.000 TL ve \xc3\xbczeri harcamalara %10 indirim sa\xc4\x9flan\xc4\xb1r.</p></html>"
        src = next(s for s in cc.load_all_sources() if s["key"] == "teb_general")
        c = cc.generic_parse(src, "https://www.teb.com.tr/sizin-icin/ultra-x/", b, fx.TODAY)
        self.assertEqual(c["eligibilityResolution"]["segment"]["option"], "ultra")
        self.assertEqual(c["eligibility"], {"segmentLabels": ["Ultra"]})

    # ---------------------------------------------------------------- QNB giyim
    def test_qnb_giyim_per_qualifying_transaction(self):
        c = by_title(self.payload, "Giyim ve Kozmetik Alışverişinize 2.000")
        self.assertEqual(c["rewardRule"], {"kind": "fixed", "minSpend": 5000.0, "reward": 500.0})
        self.assertEqual(c["periodCap"], 2000.0)
        self.assertEqual(c["transactionRules"]["allowedChannels"], ["physical"])
        self.assertTrue(c["requiresEnrollment"])
        # Family scope: the Miles&Smiles QNB card family — not rewritten to qnb-ms-private, not every QNB card
        self.assertEqual(c["cardFamilies"], ["miles-smiles-qnb"])
        self.assertEqual(c["cardProductIds"], [])
        self.assertEqual(c["eligibilityResolution"]["state"], "partial")
        self.assertEqual(c["eligibilityRule"], {"payWith": {"families": ["miles-smiles-qnb"]}})

    # ---------------------------------------------------------------- reward-total vs cumulative spend
    def test_cumulative_spend_detection(self):
        self.assertFalse(cc.is_cumulative_spend("giyim harcamalarınıza toplam 1.200 TL bonus"))
        self.assertFalse(cc.is_cumulative_spend("toplamda 2.000 TL'ye varan indirim"))
        self.assertTrue(cc.is_cumulative_spend("seyahat sektörlerinde yapacağınız toplamda 40.000 TL ve üzeri harcamaya 50.000 Mil Puan"))
        self.assertTrue(cc.is_cumulative_spend("kampanya süresince harcamalarınızın toplamı 10.000 TL'ye ulaştığında"))

    # ---------------------------------------------------------------- the JS regression consumes genuine crawler output
    def test_js_giyim_fixture_is_current_crawler_output(self):
        committed = json.loads(GIYIM_FIXTURE.read_text(encoding="utf-8"))
        import importlib.util
        spec = importlib.util.spec_from_file_location("gen", HERE.parents[1] / "tools" / "gen-giyim-fixture.py")
        gen = importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)
        self.assertEqual(committed["campaigns"], gen.build(self.payload)["campaigns"])


class LegacyRecordTests(unittest.TestCase):
    def test_source_assumed_lkg_record_is_re_resolved(self):
        old = {"id": "live-maximiles-1", "sourceKey": "maximiles", "sourceUrl": "https://www.maximiles.com.tr/kampanyalar/mc",
               "title": "MercedesCard'a Özel Giyim Harcamalarınıza 750 TL MaxiPuan!", "cardProductIds": ["is-maximiles-black"],
               "termsSummary": "Kampanya MercedesCard sahiplerine özeldir ve 1-31 Ekim 2026 tarihleri arasında geçerlidir harcamalarda.",
               "eligibilitySchemaVersion": 1, "eligibilityRule": {"payWith": {"cards": ["is-maximiles-black"]}}, "sourceKind": "official_web_live"}
        out = ce.normalize_legacy_record(old, {"maximiles": "isbank"})
        self.assertEqual(out["cardProductIds"], [])
        self.assertNotIn("eligibilityRule", out)
        self.assertEqual(old["cardProductIds"], ["is-maximiles-black"])  # input untouched

    def test_verified_url_keeps_mapping(self):
        old = {"id": "x", "sourceKey": "teb", "sourceUrl": "https://www.teb.com.tr/kart-dunyasi-otel-restoran-indirimi/",
               "title": "Otel Restoran", "cardProductIds": ["teb-infinite"], "termsSummary": "", "sourceKind": "official_web_live"}
        out = ce.normalize_legacy_record(old, {"teb": "teb"})
        self.assertEqual(out["cardProductIds"], ["teb-infinite"])
        self.assertEqual(out["eligibilityResolution"]["method"], "verified_override")

    def test_guard_reports_incomplete_even_when_equal_to_lkg(self):
        camps = [{"id": f"live-wings-{i}", "sourceKey": "wings", "sourceUrl": f"https://w/{i}", "title": f"t{i}", "endDate": "2026-12-31",
                  "sourceKind": "official_web_live"} for i in range(2)]
        lkg = {"generatedAt": "2026-10-01T00:00:00Z", "campaigns": camps, "meta": {}}
        new = {"generatedAt": "2026-10-04T00:00:00Z", "campaigns": copy.deepcopy(camps),
               "meta": {"source_reports": [{"key": "wings", "completeness": {"status": "incomplete", "confidence": "low", "reasons": ["25 aday, 1 kayıt"]}}]}}
        final, rep = cg.evaluate(new, lkg, crawl_ok=True, today="2026-10-04", keys=["wings"])
        self.assertEqual(rep["sources"]["wings"]["status"], "ok")          # count equality with LKG ...
        self.assertIn("wings", rep["incompleteSources"])                     # ... is not completeness
        self.assertIn("wings", final["meta"]["guard"]["incompleteSources"])


class ResolverTests(unittest.TestCase):
    def r(self, bank, title, text):
        return ce.resolve_from_text(bank, title, text)

    def test_states(self):
        ms = self.r("qnb", "T", "Kampanya Miles&Smiles QNB Kredi Kartı ana kart sahiplerine özel olarak geçerlidir ve uzundur.")
        self.assertEqual((ms["state"], ms["cardFamilies"], ms["cardProductIds"]), ("partial", ["miles-smiles-qnb"], []))
        pv = self.r("qnb", "T", "Kampanya yalnızca Miles&Smiles QNB Private kredi kartı sahiplerine özel olarak geçerlidir.")
        self.assertEqual((pv["state"], pv["cardProductIds"], pv["cardFamilies"]), ("resolved", ["qnb-ms-private"], []))
        self.assertEqual(self.r("akbank", "T", "Kampanyaya Axess kredi kartları ile katılım sağlanabilir ve kampanya 1-31 Ekim arası geçerlidir.")["state"], "needs_review")
        self.assertEqual(self.r("ykb", "T", "Bu metinde hiçbir kart ifadesi yer almıyor ancak satır yeterince uzun olsun diye uzatıldı.")["state"], "unresolved")
        x = self.r("isbank", "T", "Kampanyaya Maximum, Maximiles ve MercedesCard özellikli bireysel kredi kartları dahildir, ticari kartlar hariçtir.")
        self.assertEqual(x["state"], "partial")
        self.assertEqual(x["cardFamilies"], ["maximiles"]); self.assertEqual(x["cardProductIds"], [])

    def test_exclusion_and_postpositional_haric(self):
        x = self.r("teb", "T", "Kampanyaya Sade Kart hariç tüm bireysel kredi kartları dahildir ve kampanya Ekim ayı boyunca geçerlidir.")
        self.assertEqual(x["cardFamilies"], ["teb-individual-credit"])
        y = self.r("qnb", "T", "Kampanyaya tüm QNB bireysel kredi kartları dahildir, Miles&Smiles QNB kredi kartları kampanyaya dahil değildir.")
        self.assertEqual((y["cardFamilies"], y["excludedFamilies"], y["cardProductIds"]), (["qnb-individual-credit"], ["miles-smiles-qnb"], []))

    def test_free_text_never_creates_products(self):
        vocab = ce.vocabulary()
        known = set(vocab["products"])
        for f in vocab["families"]:
            self.assertTrue(set(f["products"]) <= known)
        res = ce.resolve_from_tokens("akbank", ["wings-yeni-kart"])
        self.assertEqual(res["cardProductIds"], []); self.assertEqual(res["unmappedTokens"], ["wings-yeni-kart"])


class FamilyScopeTests(unittest.TestCase):
    """A campaign targets a stable card family/program; the currently known single product is never the scope."""
    MASTER = json.loads((HERE.parent / "eligibility_master.v1.json").read_text(encoding="utf-8"))

    def test_master_families_are_incomplete_where_master_data_is(self):
        fams = {f["code"]: f for f in self.MASTER["cardFamilies"]}
        self.assertEqual(fams["teb-bonus-individual-credit"]["members"], ["teb-infinite"])
        self.assertFalse(fams["teb-bonus-individual-credit"]["membershipComplete"])
        self.assertEqual(fams["miles-smiles-qnb"]["members"], ["qnb-ms-private"])
        self.assertFalse(fams["miles-smiles-qnb"]["membershipComplete"])

    def test_family_rule_is_written_family_level_by_dual_write(self):
        import eligibility_dual_write as dw
        c = {"id": "x", "cardProductIds": [], "cardFamilies": ["teb-bonus-individual-credit"],
             "eligibilityResolution": {"excludedProducts": [], "excludedFamilies": []}, "rewardRule": {"kind": "fixed", "minSpend": 3000, "reward": 120}}
        out, status = dw.add_v1_fields(c, self.MASTER)
        self.assertEqual(status, "translated")
        self.assertEqual(out["eligibilityRule"], {"payWith": {"families": ["teb-bonus-individual-credit"]}})
        self.assertNotIn("teb-infinite", json.dumps(out["eligibilityRule"]))
        # exclusion stays a separate `not` clause (no product list rewrite)
        c2 = {**c, "cardFamilies": ["qnb-individual-credit"], "eligibilityResolution": {"excludedProducts": [], "excludedFamilies": ["miles-smiles-qnb"]}}
        out2, _ = dw.add_v1_fields(c2, self.MASTER)
        self.assertEqual(out2["eligibilityRule"], {"all": [{"payWith": {"families": ["qnb-individual-credit"]}}, {"not": {"payWith": {"families": ["miles-smiles-qnb"]}}}]})

    def test_family_rule_passes_quality_guard_validator(self):
        import eligibility_schema as es
        m = es.load_master()
        ok = {"eligibilitySchemaVersion": 1, "eligibilityRule": {"payWith": {"families": ["miles-smiles-qnb"]}}}
        self.assertEqual(es.validate_campaign(ok, m)["status"], "valid")
        unk = {"eligibilitySchemaVersion": 1, "eligibilityRule": {"payWith": {"families": ["qnb-unknown-family"]}}}
        v = es.validate_campaign(unk, m)
        self.assertEqual(v["status"], "valid"); self.assertTrue(any("unknown card family" in w for w in v["warnings"]))

    def test_family_rules_match_todays_membership_expansion_cross_language(self):
        import shutil, subprocess, tempfile
        if not shutil.which("node"):
            self.skipTest("node not available")
        camps = json.loads(GIYIM_FIXTURE.read_text(encoding="utf-8"))["campaigns"]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(camps, f, ensure_ascii=False)
        r = subprocess.run(["node", str(HERE.parents[1] / "tools" / "compare-dual-write.mjs"), f.name], capture_output=True, text=True, cwd=HERE.parents[1])
        out = json.loads(r.stdout)
        self.assertGreaterEqual(out["familyExpanded"], 2)
        self.assertEqual(out["mismatches"], [])

    def test_teb_bonus_wording_is_not_every_teb_card_and_ms_is_not_every_qnb_card(self):
        teb = ce.resolve_from_text("teb", "T", "Kampanya TEB Bonus özellikli bireysel kredi kartlarınız ile yapılan harcamalarda geçerlidir.")
        self.assertEqual(teb["cardFamilies"], ["teb-bonus-individual-credit"])
        self.assertNotIn("teb-individual-credit", teb["cardFamilies"])
        qnb = ce.resolve_from_text("qnb", "T", "Kampanya Miles&Smiles QNB Kredi Kartı ile yapılan harcamalarda geçerlidir uzunca bir cümle.")
        self.assertEqual(qnb["cardFamilies"], ["miles-smiles-qnb"])
        self.assertNotIn("qnb-individual-credit", qnb["cardFamilies"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
