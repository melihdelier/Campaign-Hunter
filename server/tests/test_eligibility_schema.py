"""v1.4.2: eligibility schema version enforcement in the catalog quality guard (fail closed, LKG preserved)."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalog_guard as cg
import eligibility_schema as es

ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((ROOT / "docs" / "eligibility-validation-cases.v1.json").read_text(encoding="utf-8"))
EXAMPLES = json.loads((ROOT / "docs" / "eligibility-examples.v1.json").read_text(encoding="utf-8"))
MASTER = es.load_master()
KEYS = ["qnb_card", "teb_general", "maximiles"]
TODAY = "2026-10-01"
RULE = {"all": [{"payWith": {"cards": ["teb-infinite"]}}, {"attr": {"dim": "teb_tier", "in": ["ultra"]}}]}


def camp(key, i, end="2026-12-31", **kw):
    c = {"id": f"live-{key}-{i}", "bank": key.upper(), "title": f"{key} kampanya {i}", "sourceKey": key,
         "sourceUrl": f"https://bank/{key}/{i}", "endDate": end, "sourceKind": "official_web", "cardProductIds": ["teb-infinite"]}
    c.update(kw)
    return c


def catalog(campaigns, gen):
    return {"version": 1, "generatedAt": gen, "campaigns": campaigns, "meta": {"partial": False}}


def lkg_catalog(**overrides):
    cs = [camp(k, i) for k in KEYS for i in range(6)]
    for c in cs:
        c.update(overrides.get(c["id"], {}))
    return catalog(cs, "2026-09-30T15:10:00+00:00")


def run(new, lkg=None, **kw):
    return cg.evaluate(new, lkg if lkg is not None else lkg_catalog(), crawl_ok=True, today=TODAY, keys=KEYS, **kw)


class SharedFixtureTests(unittest.TestCase):
    """Same fixture as web/test-eligibility.mjs, so the JS and Python validators cannot drift."""

    def test_every_case_matches_expected_catalog_status(self):
        self.assertGreaterEqual(len(CASES["cases"]), 25)
        for case in CASES["cases"]:
            with self.subTest(case["name"]):
                v = es.validate_campaign(case["campaign"], MASTER)
                self.assertEqual(v["status"], case["catalogStatus"], v)
                if case["errorContains"]:
                    self.assertTrue(any(case["errorContains"] in e for e in v["errors"]), v["errors"])
                if case["catalogStatus"] != "invalid":
                    self.assertEqual(v["errors"], [])

    def test_runtime_status_is_structural_subset(self):
        # Without master data the guard sees what the client sees at runtime.
        for case in CASES["cases"]:
            with self.subTest(case["name"]):
                self.assertEqual(es.validate_campaign(case["campaign"], None)["status"], case["runtimeStatus"])

    def test_the_five_required_cases(self):
        names = {c["name"]: c for c in CASES["cases"]}
        self.assertEqual(names["v1 rule accepted"]["catalogStatus"], "valid")
        self.assertEqual(names["rule without version rejected"]["catalogStatus"], "invalid")
        self.assertEqual(names["unsupported version 2 rejected"]["catalogStatus"], "invalid")
        self.assertEqual(names["two-key node rejected"]["catalogStatus"], "invalid")
        self.assertEqual(names["no new rule: legacy adapter"]["catalogStatus"], "legacy")

    def test_unknown_card_product_is_warning(self):
        case = next(c for c in CASES["cases"] if c["name"].startswith("unknown card product"))
        v = es.validate_campaign(case["campaign"], MASTER)
        self.assertEqual(v["status"], "valid")
        self.assertTrue(any("unknown card product qnb-fix" in w for w in v["warnings"]), v)

    def test_published_examples_are_valid(self):
        for ex in EXAMPLES["examples"]:
            with self.subTest(ex["id"]):
                v = es.validate_campaign(ex, MASTER)
                self.assertEqual(v["status"], "valid", v)

    def test_master_codes_match_bundled_seed(self):
        sql = "\n".join(p.read_text(encoding="utf-8") for p in sorted((ROOT / "supabase" / "migrations").glob("*.sql")) if p.name >= "008")
        for code in MASTER["cards"] | MASTER["banks"] | set(MASTER["dims"]):
            self.assertIn(f"'{code}'", sql, code)


class GuardFailClosedTests(unittest.TestCase):
    def test_valid_v1_rule_is_published(self):
        cs = [camp(k, i) for k in KEYS for i in range(6)]
        cs[0].update(eligibilitySchemaVersion=1, eligibilityRule=RULE)
        final, rep = run(catalog(cs, "2026-10-01T05:10:00+00:00"))
        self.assertEqual(rep["verdict"], "ok")
        self.assertEqual(rep["invalidEligibility"], [])
        pub = next(c for c in final["campaigns"] if c["id"] == cs[0]["id"])
        self.assertEqual(pub["eligibilityRule"], RULE)

    def _with_bad(self, **bad):
        cs = [camp(k, i) for k in KEYS for i in range(6)]
        cs[0].update(bad)
        return catalog(cs, "2026-10-01T05:10:00+00:00"), cs[0]["id"]

    def assert_rejected_record_kept_from_lkg(self, **bad):
        new, bad_id = self._with_bad(**bad)
        final, rep = run(new)
        self.assertEqual(rep["verdict"], "repaired")
        self.assertTrue(rep["publish"])
        self.assertEqual([e["id"] for e in rep["invalidEligibility"]], [bad_id])
        self.assertTrue(rep["invalidEligibility"][0]["restoredFromLkg"])
        kept = [c for c in final["campaigns"] if c["id"] == bad_id]
        self.assertEqual(len(kept), 1)
        self.assertTrue(kept[0]["staleFromLastKnownGood"])
        self.assertIn(cg.INVALID_RULE_WARNING, kept[0]["decisionWarnings"])
        self.assertNotIn("eligibilityRule", kept[0])  # the invalid fresh content is not published
        self.assertEqual(len(final["campaigns"]), 18)
        self.assertEqual(final["meta"]["guard"]["invalidEligibility"], [bad_id])
        return rep

    def test_missing_version_rejected_lkg_kept(self):
        rep = self.assert_rejected_record_kept_from_lkg(eligibilityRule=RULE)
        self.assertIn("missing", rep["invalidEligibility"][0]["errors"][0])

    def test_unsupported_version_rejected_lkg_kept(self):
        self.assert_rejected_record_kept_from_lkg(eligibilitySchemaVersion=2, eligibilityRule=RULE)

    def test_malformed_rule_rejected_lkg_kept(self):
        self.assert_rejected_record_kept_from_lkg(eligibilitySchemaVersion=1, eligibilityRule={"all": []})

    def test_unknown_dimension_rejected_lkg_kept(self):
        self.assert_rejected_record_kept_from_lkg(eligibilitySchemaVersion=1,
                                                  eligibilityRule={"attr": {"dim": "teb_level", "in": ["ultra"]}})

    def test_malformed_reward_variants_rejected(self):
        self.assert_rejected_record_kept_from_lkg(eligibilitySchemaVersion=1, eligibilityRule=RULE, rewardVariants=[{"when": None}])

    def test_new_invalid_campaign_without_lkg_record_is_dropped(self):
        cs = [camp(k, i) for k in KEYS for i in range(6)]
        cs.append(camp("teb_general", 99, eligibilityRule=RULE))
        final, rep = run(catalog(cs, "2026-10-01T05:10:00+00:00"))
        self.assertEqual(rep["verdict"], "repaired")
        self.assertFalse(rep["invalidEligibility"][0]["restoredFromLkg"])
        self.assertFalse(any(c["id"] == "live-teb_general-99" for c in final["campaigns"]))

    def test_never_falls_back_to_legacy_fields(self):
        # The invalid record has cardProductIds that would make it eligible under the legacy adapter;
        # it must still not be published.
        cs = [camp(k, i) for k in KEYS for i in range(6)]
        cs.append(camp("teb_general", 98, eligibilitySchemaVersion="1", eligibilityRule=RULE))
        final, _ = run(catalog(cs, "2026-10-01T05:10:00+00:00"))
        self.assertFalse(any(c["id"] == "live-teb_general-98" for c in final["campaigns"]))

    def test_source_with_all_rules_invalid_is_repaired_from_lkg(self):
        cs = [camp(k, i) for k in KEYS for i in range(6)]
        for c in cs:
            if c["sourceKey"] == "teb_general":
                c.update(eligibilitySchemaVersion=3, eligibilityRule=RULE)
        final, rep = run(catalog(cs, "2026-10-01T05:10:00+00:00"))
        self.assertEqual(rep["verdict"], "repaired")
        self.assertEqual(rep["sources"]["teb_general"]["status"], "zero")
        teb = [c for c in final["campaigns"] if c["sourceKey"] == "teb_general"]
        self.assertEqual(len(teb), 6)
        self.assertTrue(all(c["staleFromLastKnownGood"] and "eligibilityRule" not in c for c in teb))

    def test_invalid_lkg_records_are_not_restored(self):
        lkg = lkg_catalog(**{"live-teb_general-0": {"eligibilityRule": RULE}})  # LKG itself broken (no version)
        new, bad_id = self._with_bad(eligibilitySchemaVersion=2, eligibilityRule=RULE)
        self.assertEqual(bad_id, "live-qnb_card-0")
        cs = new["campaigns"]
        cs[6].update(eligibilitySchemaVersion=2, eligibilityRule=RULE)  # live-teb_general-0
        self.assertEqual(cs[6]["id"], "live-teb_general-0")
        final, rep = run(new, lkg)
        self.assertEqual([e["id"] for e in rep["lkgInvalidEligibility"]], ["live-teb_general-0"])
        ids = [c["id"] for c in final["campaigns"]]
        self.assertIn("live-qnb_card-0", ids)          # valid LKG copy restored
        self.assertNotIn("live-teb_general-0", ids)    # invalid everywhere -> not published at all

    def test_rejected_crawl_republishes_sanitised_lkg(self):
        lkg = lkg_catalog(**{"live-teb_general-0": {"eligibilitySchemaVersion": 9, "eligibilityRule": RULE}})
        final, rep = cg.evaluate(None, lkg, crawl_ok=False, today=TODAY, keys=KEYS)
        self.assertEqual(rep["verdict"], "rejected")
        self.assertFalse(rep["publish"])
        self.assertNotIn("live-teb_general-0", [c["id"] for c in final["campaigns"]])

    def test_bootstrap_drops_invalid(self):
        cs = [camp(k, i) for k in KEYS for i in range(2)]
        cs[0].update(eligibilityRule=RULE)
        final, rep = cg.evaluate(catalog(cs, "2026-10-01T05:10:00+00:00"), None, crawl_ok=True, today=TODAY, keys=KEYS,
                                 allow_bootstrap=True)
        self.assertEqual(rep["verdict"], "bootstrap")
        self.assertNotIn(cs[0]["id"], [c["id"] for c in final["campaigns"]])

    def test_legacy_only_catalog_unchanged(self):
        cs = [camp(k, i) for k in KEYS for i in range(6)]
        final, rep = run(catalog(cs, "2026-10-01T05:10:00+00:00"))
        self.assertEqual(rep["verdict"], "ok")
        self.assertEqual(rep["invalidEligibility"], [])
        self.assertEqual(len(final["campaigns"]), 18)

    def test_unknown_product_warning_reported_but_published(self):
        cs = [camp(k, i) for k in KEYS for i in range(6)]
        cs[0].update(eligibilitySchemaVersion=1, eligibilityRule={"all": [{"payWith": {"banks": ["qnb"]}}, {"not": {"payWith": {"cards": ["qnb-fix"]}}}]})
        final, rep = run(catalog(cs, "2026-10-01T05:10:00+00:00"))
        self.assertEqual(rep["verdict"], "ok")
        self.assertEqual(rep["eligibilityWarnings"][0]["id"], cs[0]["id"])
        self.assertIn(cs[0]["id"], [c["id"] for c in final["campaigns"]])


if __name__ == "__main__":
    unittest.main()
