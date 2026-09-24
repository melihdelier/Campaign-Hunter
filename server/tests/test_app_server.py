import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app_server import duplicate_candidates

class DuplicateCampaignTests(unittest.TestCase):
    def test_pasted_existing_title_warns(self):
        campaigns=[{
            'id':'live-1','bank':'Yapı Kredi','cardProductIds':['ykb-crystal'],
            'title':'Amazon’da 300 TL Worldpuan!',
            'termsSummary':'Amazon.com.tr üzerinden 3.000 TL ve üzeri alışverişlerde 300 TL Worldpuan.',
            'sourceKind':'official_web_live','sourceUrl':'https://example.test/amazon',
            'categories':['e-ticaret'],'merchantScope':{'kind':'contains','values':['Amazon']}
        }]
        q='Amazon’da 300 TL Worldpuan! Amazon.com.tr üzerinden 3.000 TL ve üzeri alışverişlerde 300 TL Worldpuan kazanabilirsiniz.'
        out=duplicate_candidates('Yapı Kredi',['ykb-crystal'],'',q,campaigns)
        self.assertTrue(out)
        self.assertEqual(out[0]['id'],'live-1')
        self.assertGreaterEqual(out[0]['score'],0.9)

    def test_other_bank_does_not_warn(self):
        campaigns=[{'id':'x','bank':'TEB','cardProductIds':['teb-infinite'],'title':'Amazon kampanyası','termsSummary':'Amazon 3000 TL'}]
        out=duplicate_candidates('Yapı Kredi',['ykb-crystal'],'Amazon kampanyası','Amazon 3000 TL',campaigns)
        self.assertEqual(out,[])

if __name__=='__main__': unittest.main(verbosity=2)
