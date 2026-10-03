"""v1.4.3: Maximiles/Crystal band rename — crawler reward rules are equivalent to the pre-rename (v1.4.2) output,
and no threshold-coded option identity remains in the crawler, guard master data or eligibility examples."""
import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import campaign_crawler as cc

ROOT = Path(__file__).resolve().parents[2]
BASE = json.loads((Path(__file__).parent / 'fixtures' / 'crawler-band-overrides.v1.json').read_text(encoding='utf-8'))
OLD_CODE = re.compile(r"\b(under_1m|1m_4m|4m_8m|8m_plus|1m_6m|6m_10m|10m_plus)\b")


class CrawlerBandRenameTests(unittest.TestCase):
    def test_overrides_equivalent_to_pre_rename_output(self):
        self.assertEqual(len(BASE['overrides']), 4)
        for o in BASE['overrides']:
            with self.subTest(o['url']):
                c = {'id': 'x', 'bank': 'Yapı Kredi' if o['product'] == 'ykb-crystal' else 'İş Bankası', 'title': 't', 'sourceUrl': o['url'],
                     'cardProductIds': [o['product']], 'transactionRules': {}, 'merchantScope': {'kind': 'all'}, 'decisionWarnings': []}
                c = cc.special_overrides(c)
                self.assertEqual(c['eligibility']['segmentLabels'], o['segmentLabels'])
                self.assertEqual(c['segmentRules'], o['segmentRules'])  # same rule per band, keyed by neutral code
                self.assertEqual(c['rewardRule'], o['rewardRule']); self.assertEqual(c['periodCap'], o['periodCap'])

    def test_no_threshold_coded_identity_in_server_outputs(self):
        for rel in ['server/campaign_crawler.py', 'server/eligibility_master.v1.json', 'docs/eligibility-examples.v1.json',
                    'supabase/migrations/008_user_profiles.sql']:
            self.assertIsNone(OLD_CODE.search((ROOT / rel).read_text(encoding='utf-8')), rel)
        master = json.loads((ROOT / 'server' / 'eligibility_master.v1.json').read_text(encoding='utf-8'))
        for d in master['dimensions']:
            for code in d['options']:
                self.assertRegex(code, r'^(?:[a-z_]+|band_\d+)$', f"{d['code']}.{code}")


if __name__ == '__main__':
    unittest.main()
