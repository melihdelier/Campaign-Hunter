import sys
import unittest
import json
import tempfile
from pathlib import Path
from datetime import date
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import campaign_crawler as cc
from campaign_crawler import generic_parse, special_overrides, known_core_fallback, http_safe_url, discover_source, FetchResult


def src(key,bank,cards): return {'key':key,'bank':bank,'card_products':cards}
def wrap(title,text): return f'<html><h1>{title}</h1><div>{text}</div></html>'.encode()

class CampaignCrawlerTests(unittest.TestCase):
    def test_qnb_school(self):
        b=wrap('Okul Alışverişlerinize 2.500 Mil Hediye!', '''Kampanya, 1-30 Eylül 2026 tarihleri arasında geçerlidir. Miles&Smiles QNB Kredi Kartınızla farklı iş yerlerinde tek seferde yapacağınız her 5.000 TL ve üzeri giyim, eğitim ve kırtasiye alışverişinize ekstra 500 Mil, toplamda 2.500 Mil'e varan hediye! Kampanyaya QNB Mobil Kampanyalar ekranından katılabilirsiniz. Aynı gün aynı işyerinde yapılan işlemlerden yalnızca ilki kampanya kapsamında ödül kazanır.''')
        c=generic_parse(src('qnb_ms','QNB',['qnb-ms-private']),'https://milesandsmilesqnb.com.tr/kampanyalar/x',b,date(2026,9,23))
        self.assertIsNotNone(c); self.assertEqual(c['rewardUnit'],'thy_miles')
        self.assertEqual(c['rewardRule']['minSpend'],5000); self.assertEqual(c['rewardRule']['reward'],500)
        self.assertEqual(c['periodCap'],2500); self.assertTrue(c['requiresEnrollment'])
        self.assertTrue(c['transactionRules']['differentMerchantsRequired'])
        self.assertFalse(c['transactionRules']['differentDaysRequired'])

    def test_qnb_general_excludes_miles(self):
        b=wrap('Şarjda 500 TL ParaPuan','''QNB Bireysel Kredi Kartı ile 750 TL üzeri alışverişe 50 TL ParaPuan. Miles&Smiles QNB ve QNB Fix kredi kartları hariçtir. Kampanya 15 Eylül - 15 Ekim 2026 tarihleri arasında geçerlidir.''')
        c=generic_parse(src('qnb_card','QNB',['qnb-ms-private']),'https://www.qnbcard.com.tr/kampanyalar/sarj',b,date(2026,9,23))
        self.assertIsNone(c)

    def test_qnb_terminal_private_override(self):
        b=wrap('QNB Terminal Kadıköy Restoran Harcamalarında %10’dan Başlayan İndirim!', '''QNB Kredi Kartı ile 1 Temmuz-31 Aralık 2026 arasında seçili restoranlarda %10. QNB Private müşterilerine %20 indirim. İşlem başına en fazla 1.000 TL, aylık en fazla 2.000 TL indirim.''')
        c=generic_parse(src('qnb_card','QNB',['qnb-ms-private']),'https://www.qnbcard.com.tr/kampanyalar/qnb-terminal-kadikoy-restoran-harcamalarinda-10dan-baslayan-indirim-42833',b,date(2026,9,23)); c=special_overrides(c)
        self.assertTrue(c['rulesComplete']); self.assertEqual(c['rewardRule']['rate'],0.20); self.assertEqual(c['periodCap'],2000)
        self.assertIn('Arabica Coffee',c['merchantScope']['values'])


    def test_wings_atu_tiers(self):
        b=wrap("ATÜ Duty Free Mağazalarında 300.000'e varan Mil Puan!", '''Wings’e özel 1-30 Eylül 2026 tarihleri arasında ATÜ Duty Free mağazalarında 25.000 TL ve üzeri harcamaya 75.000 Mil Puan, 50.000 TL ve üzeri harcamaya 150.000 Mil Puan, 100.000 TL ve üzeri harcamaya 300.000 Mil Puan! Mil Puan kampanyasına bireysel ve ticari Wings kartlar dahildir.''')
        c=generic_parse(src('wings','Akbank',['akbank-wings-black']),'https://www.wingscard.com.tr/kampanyalar/atu',b,date(2026,9,23))
        self.assertEqual(c['rewardRule']['kind'],'tiered_fixed'); self.assertEqual(c['rewardRule']['tiers'][0],{'min':25000.0,'reward':75000.0})

    def test_wings_pazarama_discount_tiers(self):
        b=wrap("Wings'e Özel Pazarama Tatil'de 7.500 TL'ye Varan İndirim!", '''Kampanya 1-30 Eylül 2026 tarihlerinde geçerlidir. Wings ile Pazarama Tatil yurtiçi ve yurtdışı otel rezervasyonlarında 50.000 - 99.999 TL arası harcamalarda 3.000 TL, 100.000 TL ve üzeri harcamalarda 7.500 TL indirim sunulmaktadır.''')
        c=generic_parse(src('wings','Akbank',['akbank-wings-black']),'https://www.wingscard.com.tr/kampanyalar/pazarama-tatilde-indirim-01',b,date(2026,9,23))
        self.assertEqual(c['rewardRule']['kind'],'tiered_fixed')
        self.assertEqual(c['rewardRule']['tiers'][0]['min'],50000)
        self.assertEqual(c['rewardRule']['tiers'][0]['reward'],3000)
        self.assertEqual(c['rewardRule']['tiers'][1]['reward'],7500)

    def test_aggregate_campaign_is_not_ranked_exactly(self):
        b=wrap('Wings Seyahat Harcamalarında 50.000 Mil Puan!', '''01-30 Eylül 2026 tarihleri arasında Wings ile seyahat sektörlerinde yapacağınız toplamda 40.000 TL ve üzeri harcamaya 50.000 Mil Puan. Kampanyaya Juzdan'dan katılın.''')
        c=generic_parse(src('wings','Akbank',['akbank-wings-black']),'https://www.wingscard.com.tr/kampanyalar/seyahat',b,date(2026,9,23))
        self.assertTrue(c['transactionRules']['cumulativeSpendCampaign']); self.assertFalse(c['rulesComplete'])

    def test_world_network(self):
        b=wrap("Network’te 3.000 TL’ye varan Worldpuan!", '''Kampanya 2-30 Eylül 2026 tarihleri arasında geçerlidir. Yapı Kredi bireysel kredi kartları dahildir. NetWork mağazalarından ve www.network.com.tr’den tek seferde yapılacak 15.000 TL ve üzeri alışverişe 1.500 TL değerinde Worldpuan, 30.000 TL ve üzeri alışverişe 2.500 TL değerinde Worldpuan kazanılacaktır. World Mobil uygulamasından kampanyaya katılın.''')
        c=generic_parse(src('world','Yapı Kredi',['ykb-crystal']),'https://www.worldcard.com.tr/kampanyalar/network',b,date(2026,9,23))
        self.assertEqual(c['rewardUnit'],'worldpuan'); self.assertTrue(c['requiresEnrollment']); self.assertEqual(c['merchantScope']['kind'],'contains')

    def test_teb_ecommerce_override(self):
        b=wrap("TEB'den E-Ticaret Harcamalarınıza %5 İndirim", '''1 Ocak 2026 tarihinden itibaren TEB Infinite Kredi Kartları’nız ile yapacağınız tek seferde 1.500 TL ve üzeri e-ticaret harcamalarınıza %5, ayda 300 TL’ye varan indirimden yararlanabilirsiniz.''')
        c=generic_parse(src('teb','TEB',['teb-infinite']),'https://www.teb.com.tr/kart-dunyasi-e-ticaret/',b,date(2026,9,23)); c=special_overrides(c)
        self.assertTrue(c['rulesComplete']); self.assertEqual(c['rewardRule']['minSpend'],1500); self.assertEqual(c['periodCap'],300); self.assertEqual(c['eligibility']['segmentLabels'],['Plus','Premium','Ultra']); self.assertEqual(c['segmentRules']['Plus']['periodCap'],200)

    def test_crystal_override(self):
        b=wrap('Otel Restoran İndirimleri', '''Crystal ile %20 indirim. Da Mario Etiler\nDa Mario İstinye Park\nGünaydın Restoran\nYapı Kredi POS ile geçerlidir.''')
        c=generic_parse(src('crystal_special','Yapı Kredi',['ykb-crystal']),'https://www.yapikredi.com.tr/bireysel-bankacilik/kartlar/otel-restoran-indirimleri',b,date(2026,9,23)); c=special_overrides(c)
        self.assertEqual(c['rewardRule']['rate'],.20); self.assertTrue(any('Da Mario' in x for x in c['merchantScope'].get('values',[]))); self.assertEqual(c['segmentRules']['10 milyon TL+']['periodCap'],10000); self.assertEqual(c['segmentRules']['Metal Crystal']['periodCap'],15000)


    def test_maximiles_black_hotel_user_band_override(self):
        b=wrap('Maximiles Black ile Otel Ödemelerinize %5 İndirim', 'Kampanya Maximiles Black müşterilerinin varlık birikimine göre farklılaşır. 1.000.000 TL, 4.000.000 TL, 8.000.000 TL bantları bulunur. Otel ödemelerinde indirim vardır.')
        c=generic_parse(src('maximiles','İş Bankası',['is-maximiles-black']),'https://www.maximiles.com.tr/kampanyalar/maximiles-black-ile-otel-odemelerinize-5-indirim',b,date(2026,9,23)); c=special_overrides(c)
        self.assertTrue(c['rulesComplete']); self.assertEqual(c['eligibility']['segmentLabels'],['1 milyon TL altı','1–4 milyon TL','4–8 milyon TL','8 milyon TL+'])
        self.assertEqual(c['rewardRule']['minSpend'],25000); self.assertEqual(c['rewardRule']['perTransactionCap'],1500); self.assertEqual(c['periodCap'],3000); self.assertEqual(c['segmentRules']['1 milyon TL altı']['periodCap'],1500)

    def test_maximiles_black_parking_user_band_override(self):
        b=wrap('Maximiles Black ile Otopark Ödemelerinizde %50 İndirim', 'Kampanya Maximiles Black müşterilerinin varlık birikimine göre farklılaşır. 1.000.000 TL, 4.000.000 TL, 8.000.000 TL bantları bulunur. Otopark ödemelerinde indirim vardır.')
        c=generic_parse(src('maximiles','İş Bankası',['is-maximiles-black']),'https://www.maximiles.com.tr/kampanyalar/maximiles-black-le-yapacaginiz-otopark-odemelerinizde-50-indirim',b,date(2026,9,23)); c=special_overrides(c)
        self.assertTrue(c['rulesComplete']); self.assertEqual(c['rewardRule']['minSpend'],500); self.assertEqual(c['rewardRule']['rate'],.50)
        self.assertEqual(c['rewardRule']['perTransactionCap'],1000); self.assertEqual(c['periodCap'],2000)


    def test_axess_general_only_when_wings_included(self):
        b=wrap('Yatsan mağazalarında 6 taksit', 'Kampanyadan Axess, Wings, Free ve Ticari kart sahipleri faydalanabilir. 7 Temmuz – 7 Ekim 2026 tarihleri arasında 5.000 TL ve üzeri alışverişlerde taksit fırsatı.')
        c=generic_parse(src('axess_general','Akbank',['akbank-wings-black']),'https://www.axess.com.tr/axess/kampanyalar/yatsan',b,date(2026,9,23))
        self.assertIsNotNone(c)
        b2=wrap('Giyimde chip-para', 'Kampanyaya bireysel Axess kartlar dahildir. Kampanyaya Wings, Free ve banka kartları dahil değildir. 1-30 Eylül 2026 tarihleri arasında geçerlidir.')
        c2=generic_parse(src('axess_general','Akbank',['akbank-wings-black']),'https://www.axess.com.tr/axess/kampanyalar/giyim',b2,date(2026,9,23))
        self.assertIsNone(c2)

    def test_teb_general_infinite_eligible(self):
        b=wrap('E-Ticaret Harcamalarınıza Toplam 1.050 TL Bonus!', 'Kampanyaya katılarak TEB Bireysel Kredi Kartlarınız ile 16-30 Eylül 2026 tarihleri arasında Amazon, Hepsiburada ve Trendyol web sitesi veya mobil uygulamalarından yapılacak her 3.500 TL ve üzeri alışverişlere 175 TL bonus, toplam 1.050 TL bonus verilecektir. Aynı gün aynı işyerinden yapılan harcamaların sadece ilki dahildir. CEPTETEB Mobil üzerinden kampanyaya katılın.')
        c=generic_parse(src('teb_general','TEB',['teb-infinite']),'https://www.teb.com.tr/sizin-icin/eticaret-1050/',b,date(2026,9,23))
        self.assertIsNotNone(c); self.assertEqual(c['rewardUnit'],'bonus'); self.assertEqual(c['rewardRule']['minSpend'],3500); self.assertEqual(c['rewardRule']['reward'],175)
        self.assertEqual(c['periodCap'],1050); self.assertTrue(c['requiresEnrollment'])

    def test_teb_general_bank_card_only_excluded(self):
        b=wrap('TEB Bireysel Banka Kartları ile 750 TL Nakit İade', 'TEB Bireysel Banka Kartları ile 1-30 Eylül 2026 tarihleri arasında market harcamalarına nakit iade.')
        c=generic_parse(src('teb_general','TEB',['teb-infinite']),'https://www.teb.com.tr/sizin-icin/debit-market-kampanyasi/',b,date(2026,9,23))
        self.assertIsNone(c)

    def test_generic_campaign_hub_is_rejected(self):
        b=wrap('Kampanyalar', 'Miles&Smiles QNB kampanyaları market seyahat akaryakıt e-ticaret sigorta indirim puan fırsatları. ' * 4)
        c=generic_parse(src('qnb_ms','QNB',['qnb-ms-private']),'https://milesandsmilesqnb.com.tr/kampanyalar/x',b,date(2026,9,23))
        self.assertIsNone(c)

    def test_specific_restaurant_title_extracts_merchant(self):
        b=wrap('İşleminiz Devam Ediyor... Moda Deniz Kulübü Restoranlarında %20 İndirim!', 'TEB Infinite Kredi Kartları ile 1-30 Eylül 2026 arasında 1.500 TL üzeri harcamaya %20 indirim. TEB bireysel kredi kartları kampanyaya dahildir.')
        c=generic_parse(src('teb_general','TEB',['teb-infinite']),'https://www.teb.com.tr/sizin-icin/moda-deniz-kulubu/',b,date(2026,9,23))
        self.assertIsNotNone(c)
        self.assertEqual(c['merchantScope']['kind'],'contains')
        self.assertTrue(any('Moda Deniz Kulübü' in x for x in c['merchantScope']['values']))

    def test_cinezone_title_does_not_become_all_restaurants(self):
        b=wrap('World Cinezone sinema büfelerindeki yeme-içme harcamalarında %10 indirim!', 'Yapı Kredi bireysel kredi kartları ile 1-30 Eylül 2026 arasında %10 indirim.')
        c=generic_parse(src('world','Yapı Kredi',['ykb-crystal']),'https://www.worldcard.com.tr/kampanyalar/cinezone',b,date(2026,9,23))
        self.assertIsNotNone(c)
        self.assertEqual(c['merchantScope']['kind'],'contains')
        self.assertTrue(any('World Cinezone' in x for x in c['merchantScope']['values']))


    def test_teb_script_cookie_noise_is_ignored(self):
        html = """<html><head><title>TEB</title><script>// description: Bankamızın bilgisi dahilinde kullanılan üçüncü parti tedarikçilere ait çerezlerdir; kampanyaBoxContainer; var fake='%5 indirim 9.500 TL'; new Date();</script></head><body><h1>İşleminiz Devam Ediyor... Servant'ta %20'ye varan İndirim!</h1><p>TEB Infinite Card’larınız ile Servant’ta yapacağınız harcamalarınızda %20 indirimden yararlanabilirsiniz.</p><p>TEB Signature Card’larınız ile Servant’ta yapacağınız harcamalarınızda %10 indirimden yararlanabilirsiniz.</p><p>Kampanya 10.04.2026 – 06.04.2027 tarihleri arasında geçerlidir.</p><p>Aynı gün aynı işyerinden yapılan harcamalarda indirim sadece ilk işlem için geçerlidir.</p><p>İşlem bazında maksimum 1.000 TL indirim alınabilir. Aylık ise toplam 10.000 TL indirim alınabilmektedir.</p><p>TEB POSlarından yapılan harcamalarda geçerlidir.</p></body></html>"""
        b = html.encode('utf-8')
        c=generic_parse(src('teb','TEB',['teb-infinite']),'https://www.teb.com.tr/kart-dunyasi-servant/',b,date(2026,9,23))
        self.assertIsNotNone(c)
        self.assertEqual(c['title'], "Servant'ta %20'ye varan İndirim!")
        self.assertEqual(c['rewardRule']['rate'], .20)
        self.assertEqual(c['rewardRule']['perTransactionCap'], 1000)
        self.assertEqual(c['periodCap'], 10000)
        self.assertNotIn('kampanyaBoxContainer', c['termsSummary'])
        self.assertNotIn('çerez', c['termsSummary'].lower())
        self.assertEqual(c['merchantScope']['kind'],'contains')

    def test_unicode_campaign_url_is_percent_encoded(self):
        u="https://www.worldcard.com.tr/kampanyalar/burger-king®-ve-koctas’ta"
        safe=http_safe_url(u)
        self.assertNotIn("®", safe); self.assertNotIn("’", safe)
        self.assertIn("%C2%AE", safe); self.assertIn("%E2%80%99", safe)

    def test_wings_official_source_does_not_require_word_wings_in_body(self):
        b=wrap('Minoa’da %20 indirim!', '1-30 Eylül 2026 arasında kart sahipleri Minoa restoranında %20 indirimden yararlanır. Kampanya fiziki restoran harcamalarında geçerlidir ve diğer indirimlerle birleştirilemez.')
        c=generic_parse(src('wings','Akbank',['akbank-wings-black']),'https://www.wingscard.com.tr/wings-style/minoa-indirim-wings-style',b,date(2026,9,23))
        self.assertIsNotNone(c)
        self.assertEqual(c['merchantScope']['kind'],'contains')

    def test_crystal_headings_do_not_import_site_navigation(self):
        raw_html="""<html><body><h1>Yurt İçi Otel ve Restoran İndirimi</h1><nav><div>Krediler</div><div>Kredi Kartları</div><div>Sigorta ve Emeklilik</div></nav><main><h2>Da Mario</h2><h3>Da Mario Etiler</h3><h2>Günaydın</h2><p>Crystal ile %20 indirim. Yapı Kredi POS ile geçerlidir.</p></main></body></html>"""
        c=generic_parse(src('crystal_special','Yapı Kredi',['ykb-crystal']),'https://www.yapikredi.com.tr/bireysel-bankacilik/kartlar/otel-restoran-indirimleri',raw_html.encode('utf-8'),date(2026,9,23)); c=special_overrides(c)
        vals=c['merchantScope']['values']
        self.assertIn('Da Mario', vals); self.assertIn('Günaydın', vals)
        self.assertNotIn('Krediler', vals); self.assertNotIn('Kredi Kartları', vals)

    def test_world_merchant_scope_does_not_inherit_unrelated_body_brand(self):
        b=wrap('Network’te 3.000 TL’ye varan Worldpuan!', 'Yapı Kredi bireysel kredi kartları dahildir. Network mağazalarında geçerlidir. Önerilen kampanya: Hepsiburada fırsatları.')
        c=generic_parse(src('world','Yapı Kredi',['ykb-crystal']),'https://www.worldcard.com.tr/kampanyalar/network',b,date(2026,9,23))
        self.assertIn('Network', c['merchantScope']['values'])
        self.assertNotIn('Hepsiburada', c['merchantScope']['values'])

    def test_brand_title_forces_market_category(self):
        b=wrap("Migros'ta Chippin ile 150 TL Worldpuan!", 'Yapı Kredi bireysel kredi kartları ile fırsat. Sayfa altında seyahat, akaryakıt ve e-ticaret önerileri yer alabilir.')
        c=generic_parse(src('world','Yapı Kredi',['ykb-crystal']),'https://www.worldcard.com.tr/kampanyalar/migros',b,date(2026,9,23))
        self.assertEqual(c['categories'], ['market'])

    def test_ikea_does_not_inherit_fuel_from_page_chrome(self):
        b=wrap("IKEA’da peşin fiyatına 6 taksit fırsatı!", 'Genel Kampanyalar Seyahat Akaryakıt E-ticaret Sigorta. IKEA mağazalarında peşin fiyatına 6 taksit.')
        c=generic_parse(src('world','Yapı Kredi',['ykb-crystal']),'https://www.worldcard.com.tr/kampanyalar/ikea',b,date(2026,9,24))
        self.assertEqual(c['categories'], ['ev'])
        self.assertEqual(c['categorySource'], 'title_brand')

    def test_apple_microsoft_is_digital_not_fuel(self):
        b=wrap('Mastercard logolu kartınız ile Apple ve Microsoft Platformlarından yapacağınız harcamalara 300 TL indirim!', 'Seyahat Akaryakıt E-ticaret önerileri. Apple ve Microsoft platformlarında geçerlidir.')
        c=generic_parse(src('world','Yapı Kredi',['ykb-crystal']),'https://www.worldcard.com.tr/kampanyalar/apple-microsoft',b,date(2026,9,24))
        self.assertEqual(c['categories'], ['dijital'])
        self.assertNotIn('akaryakit', c['categories'])

    def test_voltrun_is_ev_charge_not_fuel(self):
        b=wrap('Voltrun’da 400 TL ve üzeri harcamaya 300 TL’ye varan Worldpuan!', 'Voltrun elektrikli araç şarj istasyonlarında geçerlidir.')
        c=generic_parse(src('world','Yapı Kredi',['ykb-crystal']),'https://www.worldcard.com.tr/kampanyalar/voltrun',b,date(2026,9,24))
        self.assertEqual(c['categories'], ['sarj'])

    def test_official_category_hint_overrides_body_noise(self):
        b=wrap('Marka kampanyası', 'Yapı Kredi bireysel kredi kartları ile geçerli kampanya. Sayfada seyahat, sigorta, e-ticaret gibi başka menü metinleri bulunuyor. Kampanya koşulları ve avantaj detayları burada açıklanmaktadır.')
        c=generic_parse(src('world','Yapı Kredi',['ykb-crystal']),'https://www.worldcard.com.tr/kampanyalar/x',b,date(2026,9,24),category_hint=['akaryakit'])
        self.assertEqual(c['categories'], ['akaryakit'])
        self.assertEqual(c['categorySource'], 'official_category_page')
        self.assertEqual(c['categoryConfidence'], 'high')

    def test_unknown_category_stays_other_instead_of_random_body_keywords(self):
        b=wrap('Genel kart avantajı', 'Yapı Kredi bireysel kredi kartları ile geçerli kampanya. Seyahat Akaryakıt E-ticaret Sigorta menüsü. Bu metin yalnız sayfa menüsüdür; kampanya kart avantajı sunar ve belirli bir harcama sektörü açıklamaz.')
        c=generic_parse(src('world','Yapı Kredi',['ykb-crystal']),'https://www.worldcard.com.tr/kampanyalar/generic',b,date(2026,9,24))
        self.assertEqual(c['categories'], ['diger'])

    def test_teb_restaurant_ultra_override(self):
        b=wrap("TEB Infinite Otel Restoran İndirimi", "TEB Infinite Kredi Kartları ile yurt içi otel ve restoran harcamalarında 1.500 TL ve üzeri işlemlerde Ultra paket %20 indirim. Aynı gün aynı işyerinde yalnız ilk işlem geçerlidir.")
        c=generic_parse(src('teb','TEB',['teb-infinite']),'https://www.teb.com.tr/kart-dunyasi-otel-restoran-indirimi/',b,date(2026,9,24)); c=special_overrides(c)
        self.assertIsNotNone(c); self.assertTrue(c['rulesComplete'])
        self.assertEqual(c['segmentRules']['Ultra']['rewardRule']['rate'], .20)
        self.assertEqual(c['segmentRules']['Ultra']['rewardRule']['minSpend'], 1500)
        self.assertEqual(c['segmentRules']['Ultra']['periodCap'], 8000)
        self.assertEqual(c['merchantScope']['kind'], 'all')

    def test_maximiles_restaurant_4_8m_override(self):
        b=wrap("Maximiles Black ile Restoranlarda %20'ye Varan İndirim Ayrıcalığı", "Maximiles Black bireysel kartlarla restoran harcamalarında varlık bantlarına göre indirim. 4.000 TL ve üzeri restoran harcamaları kampanyaya dahildir. 1.000.000 TL, 4.000.000 TL ve 8.000.000 TL varlık bantları uygulanır.")
        c=generic_parse(src('maximiles','İş Bankası',['is-maximiles-black']),'https://www.maximiles.com.tr/kampanyalar/maximiles-black-ile-restoranlarda-20-indirim-ayricaligi',b,date(2026,9,24)); c=special_overrides(c)
        self.assertIsNotNone(c); self.assertTrue(c['rulesComplete'])
        rule=c['segmentRules']['4–8 milyon TL']['rewardRule']
        self.assertEqual(rule['kind'],'tiered_percent'); self.assertEqual(rule['tiers'][0]['rate'],.10)
        self.assertEqual(c['segmentRules']['4–8 milyon TL']['periodCap'],8000)
        self.assertEqual(c['merchantScope']['kind'], 'all')

    def test_wings_program_restaurant_override(self):
        b=wrap('Tüm Restoranlarda %15’e Varan İndirim', 'Wings ile tüm dünyadaki restoran harcamalarında %15’e varan, ayda 2.500 TL’ye kadar indirim. Bankacılık ve kart ayrıcalıklarından yararlanmak için Wings Programları’na katılın.')
        c=generic_parse(src('wings','Akbank',['akbank-wings-black','akbank-wings-elite']),'https://www.wingscard.com.tr/ayricaliklar/tum-restoranlarda-15e-varan-indirim',b,date(2026,9,24)); c=special_overrides(c)
        self.assertTrue(c['rulesComplete']); self.assertTrue(c['requiresEnrollment'])
        self.assertEqual(c['segmentRules']['Black Plus / 2 milyon TL+']['rewardRule']['rate'],.15)
        self.assertEqual(c['segmentRules']['Black Plus / 2 milyon TL+']['periodCap'],2500)
        self.assertEqual(c['merchantScope']['kind'],'all')

    def test_known_core_fallback_survives_short_script_page(self):
        tiny=b'<html><title>Blocked</title><body>short</body></html>'
        source=src('maximiles','İş Bankası',['is-maximiles-black'])
        c=known_core_fallback(source,'https://www.maximiles.com.tr/kampanyalar/maximiles-black-ile-restoranlarda-20-indirim-ayricaligi',tiny,date(2026,9,24)); c=special_overrides(c)
        self.assertIsNotNone(c); self.assertTrue(c['rulesComplete'])
        self.assertEqual(c['segmentRules']['4–8 milyon TL']['periodCap'],8000)
        self.assertEqual(c['merchantScope']['kind'],'all')

    def test_refresh_uses_staging_until_all_sources_finish(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); catalog=root/'catalog.json'; staging=root/'catalog_staging.json'; status=root/'status.json'; raw=root/'raw'; raw.mkdir()
            old_payload={"version":1,"generatedAt":"old","campaigns":[{"id":"old","sourceUrl":"https://old","sourceKey":"old","bank":"X","title":"Old"}],"meta":{"partial":False}}
            catalog.write_text(json.dumps(old_payload),encoding='utf-8')
            sources=[
                {"key":"s1","bank":"B1","card_products":["c1"],"fallback_urls":[],"listing_urls":[],"sitemap_urls":[]},
                {"key":"s2","bank":"B2","card_products":["c2"],"fallback_urls":[],"listing_urls":[],"sitemap_urls":[]},
            ]
            urls={"s1":["https://x/s1"],"s2":["https://x/s2"]}
            def discover(source): return urls[source['key']], []
            def fake_fetch(url, timeout=12): return FetchResult(url,'<html><h1>X</h1><p>kampanya indirim harcama 1.000 TL ve daha fazla yeterli metin olsun diye burada uzatıyoruz.</p></html>'.encode('utf-8'),'text/html')
            def fake_parse(source,url,body,today):
                if source['key']=='s2':
                    # İkinci kaynak işlenirken karar motorunun stable kataloğu hâlâ eski tam katalog olmalı.
                    stable=json.loads(catalog.read_text(encoding='utf-8')); self.assertEqual(stable['generatedAt'],'old')
                    stage=json.loads(staging.read_text(encoding='utf-8')); self.assertTrue(stage['meta']['partial'])
                return {"id":f"{source['key']}-c","sourceUrl":url,"sourceKey":source['key'],"bank":source['bank'],"title":source['key'],"cardProductIds":source['card_products'],"categories":["all"],"merchantScope":{"kind":"all"},"status":"active","rewardRule":{"kind":"fixed","minSpend":0,"reward":1},"transactionRules":{},"rulesComplete":True,"rawTextDigest":source['key']}
            with patch.object(cc,'CATALOG_FILE',catalog), patch.object(cc,'STAGING_FILE',staging), patch.object(cc,'STATUS_FILE',status), patch.object(cc,'RAW_DIR',raw), patch.object(cc,'load_config',return_value=sources), patch.object(cc,'discover_source',side_effect=discover), patch.object(cc,'fetch',side_effect=fake_fetch), patch.object(cc,'generic_parse',side_effect=fake_parse):
                out=cc._refresh_catalog_impl(max_per_source=10)
            self.assertFalse(staging.exists())
            stable=json.loads(catalog.read_text(encoding='utf-8'))
            self.assertFalse(stable['meta']['partial']); self.assertEqual(stable['meta']['campaign_count'],2)
            self.assertEqual(out['meta']['campaign_count'],2)

    def test_fallback_urls_have_priority_over_large_listing(self):
        from unittest.mock import patch
        fallback='https://example.com/kampanyalar/critical-restoran'
        links=''.join(f'<a href="/kampanyalar/item-{i}">x</a>' for i in range(200))
        source={'key':'x','bank':'X','card_products':['c'],'domains':['example.com'],'listing_urls':['https://example.com/kampanyalar'],'sitemap_urls':[], 'include_url_substrings':['/kampanyalar/'],'fallback_urls':[fallback]}
        with patch('campaign_crawler.fetch', return_value=FetchResult('https://example.com/kampanyalar', links.encode(), 'text/html')):
            urls,errors=discover_source(source)
        self.assertEqual(errors,[])
        self.assertEqual(urls[0], fallback)
        self.assertGreater(len(urls), 100)

if __name__=='__main__': unittest.main(verbosity=2)
