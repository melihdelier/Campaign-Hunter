"""v1.5.0: crawler dual-write — schema v1 fields are added NEXT TO the legacy fields, with proven legacy parity.

The parity check is cross-language: the Python crawler output is evaluated by the real client code
(tools/compare-dual-write.mjs → web/eligibility.js + web/engine.js), legacy record vs v1 record, for every card product,
every segment option and "unknown", and several amounts. Only the documented, verified QNB Terminal correction may differ.
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import campaign_crawler as cc
import eligibility_dual_write as dw
import eligibility_schema as es
import source_registry as sr

ROOT = Path(__file__).resolve().parents[2]
MASTER = dw.load_master()
CODES = es.load_master()
QNB_TERMINAL = 'qnb-terminal-kadikoy-restoran-harcamalarinda'


def base(url, bank, cards, **kw):
    c = {'id': 'live-' + re.sub(r'[^a-z0-9]+', '-', url.lower())[-60:], 'bank': bank, 'title': url, 'sourceUrl': 'https://x/' + url,
         'sourceKey': 'test', 'sourceKind': 'official_web', 'cardProductIds': cards, 'transactionRules': {}, 'decisionWarnings': [],
         'merchantScope': {'kind': 'all'}, 'categories': ['restoran'], 'rewardRule': {'kind': 'percent', 'rate': 0.1, 'minSpend': 0},
         'periodCap': None, 'status': 'active', 'startDate': '2026-01-01', 'endDate': '2026-12-31', 'resetPolicy': 'monthly', 'rulesComplete': True}
    c.update(kw)
    return c


def override_campaigns():
    src = Path(cc.__file__).read_text(encoding='utf-8')
    a = src.index('def special_overrides'); b = src.index('\ndef ', a + 10)
    tokens = re.findall(r'"([^"]+)" in url', src[a:b])
    out = []
    for t in tokens:
        if 'teb.com.tr' in t: bank, cards = 'TEB', ['teb-infinite']
        elif 'wingscard' in t: bank, cards = 'Akbank', ['akbank-wings-elite', 'akbank-wings-black']
        elif 'maximiles' in t: bank, cards = 'İş Bankası', ['is-maximiles-black']
        elif 'otel-restoran-indirimleri' in t: bank, cards = 'Yapı Kredi', ['ykb-crystal']
        else: bank, cards = 'QNB', ['qnb-ms-private']
        c = cc.special_overrides(base(t, bank, cards))
        if c is not None:
            out.append(c)
    return out


class TranslationTests(unittest.TestCase):
    def test_wings_labels_map_to_codes_and_variants(self):
        c = cc.special_overrides(base('wingscard.com.tr/ayricaliklar/tum-restoranlarda-15e-varan-indirim', 'Akbank', ['akbank-wings-elite', 'akbank-wings-black']))
        new, status = dw.add_v1_fields(c, MASTER, CODES)
        self.assertEqual(status, 'translated')
        self.assertEqual(new['eligibilitySchemaVersion'], 1)
        self.assertEqual(new['eligibilityRule'], {'all': [{'payWith': {'cards': ['akbank-wings-elite', 'akbank-wings-black']}},
                                                          {'attr': {'dim': 'wings_tier', 'in': ['standard', 'black', 'black_plus']}}]})
        self.assertEqual([v['when'] for v in new['rewardVariants']], [{'attr': {'dim': 'wings_tier', 'in': [x]}} for x in ['standard', 'black', 'black_plus']])
        self.assertEqual([v['rewardRule']['rate'] for v in new['rewardVariants']], [0.05, 0.10, 0.15])
        self.assertFalse(any(v['when'] == {'always': True} for v in new['rewardVariants']), 'no implicit fallback')
        # legacy fields untouched (old clients)
        self.assertEqual(new['eligibility']['segmentLabels'], c['eligibility']['segmentLabels'])
        self.assertEqual(new['segmentRules'], c['segmentRules'])
        self.assertEqual(es.validate_campaign(new, CODES)['status'], 'valid')

    def test_card_only_campaign(self):
        new, status = dw.add_v1_fields(base('x', 'İş Bankası', ['is-maximiles-black']), MASTER, CODES)
        self.assertEqual(status, 'translated')
        self.assertEqual(new['eligibilityRule'], {'payWith': {'cards': ['is-maximiles-black']}})
        self.assertNotIn('rewardVariants', new)

    def test_unmappable_label_stays_legacy_only(self):
        c = base('x', 'Yapı Kredi', ['ykb-crystal'], eligibility={'segmentLabels': ['band_1', 'Metal Crystal']})
        new, status = dw.add_v1_fields(c, MASTER, CODES)
        self.assertTrue(status.startswith('legacy_only:unmapped_labels'))
        self.assertNotIn('eligibilityRule', new)

    def test_segment_rules_without_labels_not_given_implicit_fallback(self):
        c = base('x', 'TEB', ['teb-infinite'], segmentRules={'Ultra': {'rewardRule': {'kind': 'percent', 'rate': 0.2}}})
        new, status = dw.add_v1_fields(c, MASTER, CODES)
        self.assertEqual(status, 'legacy_only:segment_rules_without_labels')

    def test_no_card_products_stays_legacy(self):
        self.assertEqual(dw.add_v1_fields(base('x', 'QNB', []), MASTER, CODES)[1], 'legacy_only:no_card_products')

    def test_explicit_v1_override_is_kept(self):
        c = cc.special_overrides(base(QNB_TERMINAL, 'QNB', ['qnb-ms-private']))
        new, status = dw.add_v1_fields(c, MASTER, CODES)
        self.assertEqual(status, 'already_v1')
        self.assertEqual(new['eligibilityRule'], {'payWith': {'banks': ['qnb']}})
        self.assertEqual([v['rewardRule']['rate'] for v in new['rewardVariants']], [0.20, 0.15, 0.10])
        self.assertEqual(new['rewardVariants'][-1]['when'], {'always': True})
        self.assertEqual(new['eligibility']['segmentLabels'], ['Private'], 'legacy fields for old clients unchanged')
        self.assertEqual(es.validate_campaign(new, CODES)['status'], 'valid')

    def test_multi_dimension_cards_use_any(self):
        # Synthetic master: two cards with different segment dimensions → any[ all[payWith A, attr dimA], all[payWith B, attr dimB] ]
        master = json.loads(json.dumps(MASTER))
        c = base('x', 'Mix', ['teb-infinite', 'qnb-ms-private'], eligibility={'segmentLabels': ['Ultra', 'Private']})
        new, status = dw.add_v1_fields(c, master, CODES)
        self.assertTrue(status.startswith('legacy_only'), 'labels must ALL map inside one dimension per card')
        c2 = base('x', 'Mix', ['teb-infinite', 'akbank-wings-black'], eligibility={'segmentLabels': ['Ultra']})
        self.assertTrue(dw.add_v1_fields(c2, master, CODES)[1].startswith('legacy_only'))

    def test_dual_write_catalog_stats_and_private_untouched(self):
        priv = base('p', 'QNB', ['qnb-ms-private'], sourceKind='user_private')
        out, stats = dw.dual_write_catalog([priv, base('x', 'İş Bankası', ['is-maximiles-black'])], MASTER)
        self.assertNotIn('eligibilityRule', out[0])
        self.assertEqual(stats, {'translated': 1})


@unittest.skipIf(shutil.which('node') is None, 'node not available')
class CrossLanguageParityTests(unittest.TestCase):
    def run_compare(self, campaigns, intentional=()):
        tmp = Path(tempfile.mkdtemp()) / 'c.json'
        tmp.write_text(json.dumps(campaigns, ensure_ascii=False), encoding='utf-8')
        r = subprocess.run(['node', str(ROOT / 'tools' / 'compare-dual-write.mjs'), str(tmp), ','.join(intentional)], capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_crawler_overrides_legacy_vs_v1_parity(self):
        camps, _ = dw.dual_write_catalog(override_campaigns(), MASTER)
        terminal_ids = [c['id'] for c in camps if QNB_TERMINAL in c['sourceUrl']]
        res = self.run_compare(camps, terminal_ids)
        self.assertGreaterEqual(res['compared'], 8)
        self.assertGreater(res['checked'], 200)
        self.assertEqual(res['mismatches'], [], json.dumps(res['mismatches'][:5], ensure_ascii=False))
        # The ONLY intentional difference: QNB Terminal (official page verified 2026-10-04): non-Private QNB cardholders
        # become eligible (10%), First Plus gets 15%. Private stays 20%.
        diffs = res['intentionalDiffs']
        self.assertTrue(diffs)
        self.assertTrue(all(d['card'] == 'qnb-ms-private' for d in diffs))
        self.assertFalse(any(d['attrs'] == {'qnb_segment': 'private'} for d in diffs), 'Private result unchanged')

    def test_static_catalog_snapshot_parity(self):
        cat = json.loads((ROOT / 'web' / 'data' / 'catalog.json').read_text(encoding='utf-8'))
        res = self.run_compare(cat['campaigns'])
        self.assertGreaterEqual(res['compared'], 4)
        self.assertEqual(res['mismatches'], [])


class SourceRegistryTests(unittest.TestCase):
    def test_registry_config_fields_and_disabled_sources(self):
        all_sources = sr.load_all()
        for s in all_sources:
            for k in ('key', 'bank', 'bank_code', 'source_type', 'enabled', 'cadence', 'priority', 'listing_urls'):
                self.assertIn(k, s, f"{s['key']}.{k}")
            self.assertTrue(all(u.startswith('https://') for u in s['listing_urls']))
        disabled = {s['bank_code'] for s in all_sources if not sr.is_active(s)}
        self.assertEqual(disabled, {'garanti', 'ziraat', 'halkbank', 'vakifbank'})
        self.assertNotIn('denizbank', {s['bank_code'] for s in all_sources}, 'no unverified source configured')
        # crawler never fetches disabled sources
        self.assertEqual({s['key'] for s in cc.load_config()}, {s['key'] for s in all_sources if sr.is_active(s)})
        self.assertTrue(all(s['bank_code'] in CODES['banks'] for s in all_sources))

    def test_build_registry_runtime_state(self):
        all_sources = sr.load_all()
        camps = [{'sourceKey': 'wings', 'id': 'a'}, {'sourceKey': 'maximiles', 'id': 'b', 'staleFromLastKnownGood': True}]
        prev = [{'sourceCode': 'maximiles', 'lastSuccessAt': '2026-10-01T05:00:00+00:00', 'health': 'ok'}]
        reg = {r['sourceCode']: r for r in sr.build_registry(all_sources, camps, '2026-10-04T05:00:00+00:00', prev)}
        self.assertEqual(reg['wings']['health'], 'ok'); self.assertEqual(reg['wings']['lastSuccessAt'], '2026-10-04T05:00:00+00:00')
        self.assertEqual(reg['maximiles']['health'], 'zero'); self.assertEqual(reg['maximiles']['lastSuccessAt'], '2026-10-01T05:00:00+00:00')
        self.assertEqual(reg['garanti_bonus']['health'], 'disabled'); self.assertIsNone(reg['garanti_bonus']['lastCrawlAt'])
        self.assertFalse(reg['garanti_bonus']['enabled'])
        rep = {'repairedSources': [{'key': 'maximiles'}], 'sources': {'maximiles': {'status': 'zero'}}}
        after = {r['sourceCode']: r for r in sr.apply_guard_status(list(reg.values()), rep, prev)}
        self.assertEqual(after['maximiles']['health'], 'repaired_from_lkg')

    def test_static_catalog_carries_registry(self):
        cat = json.loads((ROOT / 'web' / 'data' / 'catalog.json').read_text(encoding='utf-8'))
        self.assertEqual({r['sourceCode'] for r in cat['meta']['sourceRegistry']}, {s['key'] for s in sr.load_all()})


if __name__ == '__main__':
    unittest.main()
