"""v1.2.2 regression tests for finding #2 (CI last-known-good + quality gate) and publish_supabase."""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalog_guard as cg
import publish_supabase as ps
import campaign_crawler as cc

KEYS = ['qnb_ms', 'qnb_card', 'wings', 'teb_general', 'maximiles']
TODAY = '2026-10-01'


def camp(key, i, end='2026-12-31', **kw):
    c = {'id': f'live-{key}-{i}', 'bank': key.upper(), 'title': f'{key} kampanya {i}', 'sourceKey': key,
         'sourceUrl': f'https://bank/{key}/{i}', 'endDate': end, 'sourceKind': 'official_web'}
    c.update(kw)
    return c


def catalog(counts, gen='2026-10-01T05:10:00+00:00', **meta):
    cs = [camp(k, i) for k, n in counts.items() for i in range(n)]
    return {'version': 1, 'generatedAt': gen, 'campaigns': cs, 'meta': {'partial': False, **meta}}


LKG = catalog({'qnb_ms': 9, 'qnb_card': 12, 'wings': 3, 'teb_general': 4}, gen='2026-09-30T15:10:00+00:00')


def run(new, lkg=LKG, ok=True):
    return cg.evaluate(new, lkg, crawl_ok=ok, today=TODAY, keys=KEYS)


class GuardEvaluateTests(unittest.TestCase):
    def test_healthy_crawl_is_published_unchanged(self):
        new = catalog({'qnb_ms': 10, 'qnb_card': 11, 'wings': 3, 'teb_general': 4})
        final, rep = run(new)
        self.assertEqual(rep['verdict'], 'ok'); self.assertTrue(rep['publish'])
        self.assertEqual(len(final['campaigns']), 28)
        self.assertEqual(final['meta']['guard']['verdict'], 'ok')

    def test_previously_healthy_source_zero_is_repaired_from_lkg(self):
        new = catalog({'qnb_ms': 10, 'qnb_card': 11, 'wings': 0, 'teb_general': 4})
        final, rep = run(new)
        self.assertEqual(rep['verdict'], 'repaired'); self.assertTrue(rep['publish'])
        wings = [c for c in final['campaigns'] if c['sourceKey'] == 'wings']
        self.assertEqual(len(wings), 3)
        self.assertTrue(all(c['staleFromLastKnownGood'] for c in wings))
        self.assertTrue(all(cg.STALE_WARNING in c['decisionWarnings'] for c in wings))
        self.assertEqual(final['meta']['guard']['repairedSources'], ['wings'])

    def test_severe_source_drop_keeps_fresh_and_restores_missing(self):
        new = catalog({'qnb_ms': 9, 'qnb_card': 2, 'wings': 3, 'teb_general': 4})  # 2 < 40% of 12
        final, rep = run(new)
        self.assertEqual(rep['verdict'], 'repaired')
        card = [c for c in final['campaigns'] if c['sourceKey'] == 'qnb_card']
        self.assertEqual(len(card), 12)  # 2 fresh (same URLs as LKG 0,1) + 10 restored
        self.assertEqual(sum(1 for c in card if not c.get('staleFromLastKnownGood')), 2)

    def test_never_healthy_source_zero_is_not_degraded(self):
        new = catalog({'qnb_ms': 9, 'qnb_card': 12, 'wings': 3, 'teb_general': 4, 'maximiles': 0})
        final, rep = run(new)
        self.assertEqual(rep['verdict'], 'ok')
        self.assertEqual(rep['sources']['maximiles']['status'], 'never_healthy')

    def test_severe_total_drop_is_rejected_and_lkg_kept(self):
        new = catalog({'qnb_ms': 3, 'qnb_card': 5, 'wings': 3, 'teb_general': 2})  # 13 < 50% of 28
        final, rep = run(new)
        self.assertEqual(rep['verdict'], 'rejected'); self.assertFalse(rep['publish'])
        self.assertIs(final, LKG)

    def test_many_healthy_sources_zero_is_rejected(self):
        new = catalog({'qnb_ms': 20, 'qnb_card': 0, 'wings': 0, 'teb_general': 4})
        final, rep = run(new)
        self.assertEqual(rep['verdict'], 'rejected')

    def test_crawl_failure_partial_or_not_newer_is_rejected(self):
        self.assertEqual(run(catalog({'qnb_ms': 9}), ok=False)[1]['verdict'], 'rejected')
        self.assertEqual(run(catalog({'qnb_ms': 9, 'qnb_card': 12, 'wings': 3, 'teb_general': 4}, partial=True))[1]['verdict'], 'rejected')
        same = dict(LKG)  # crawler crashed before writing -> catalog.json is still the LKG seed
        self.assertEqual(run(same)[1]['verdict'], 'rejected')
        self.assertEqual(run(None)[1]['verdict'], 'rejected')

    def test_all_stale_crawl_is_rejected(self):
        new = catalog({'qnb_ms': 9, 'qnb_card': 12, 'wings': 3, 'teb_general': 4})
        for c in new['campaigns']:
            c['staleFromLastKnownGood'] = True
        self.assertEqual(run(new)[1]['verdict'], 'rejected')

    def test_expired_lkg_records_are_not_resurrected(self):
        lkg = catalog({'qnb_ms': 9, 'qnb_card': 12, 'wings': 3, 'teb_general': 4}, gen='2026-09-30T15:10:00+00:00')
        lkg['campaigns'].append(camp('wings', 99, end='2026-09-30'))
        new = catalog({'qnb_ms': 10, 'qnb_card': 11, 'wings': 0, 'teb_general': 4})
        new['campaigns'].append(dict(camp('wings', 99, end='2026-09-30'), staleFromLastKnownGood=True))
        final, rep = run(new, lkg)
        ids = [c['id'] for c in final['campaigns']]
        self.assertNotIn('live-wings-99', ids)
        self.assertEqual(len([i for i in ids if i.startswith('live-wings-')]), 3)

    def test_single_record_source_dropping_to_zero_is_repaired(self):
        # Review finding: baseline=1 -> fresh=0 used to return 'ok' and the record vanished.
        lkg = catalog({'qnb_ms': 9, 'qnb_card': 12, 'wings': 1, 'teb_general': 4}, gen='2026-09-30T15:10:00+00:00')
        new = catalog({'qnb_ms': 9, 'qnb_card': 12, 'wings': 0, 'teb_general': 4})
        final, rep = run(new, lkg)
        self.assertEqual(rep['sources']['wings'], {'baseline': 1, 'fresh': 0, 'status': 'zero'})
        self.assertEqual(rep['verdict'], 'repaired'); self.assertTrue(rep['publish'])
        wings = [c for c in final['campaigns'] if c['sourceKey'] == 'wings']
        self.assertEqual([c['id'] for c in wings], ['live-wings-0'])
        self.assertTrue(wings[0]['staleFromLastKnownGood'])

    def test_single_expired_record_is_not_a_healthy_baseline(self):
        lkg = catalog({'qnb_ms': 9, 'qnb_card': 12, 'teb_general': 4}, gen='2026-09-30T15:10:00+00:00')
        lkg['campaigns'].append(camp('wings', 0, end='2026-09-30'))
        final, rep = run(catalog({'qnb_ms': 9, 'qnb_card': 12, 'teb_general': 4}), lkg)
        self.assertEqual(rep['verdict'], 'ok')
        self.assertNotIn('live-wings-0', [c['id'] for c in final['campaigns']])

    def test_no_lkg_fails_closed_by_default(self):
        # Review finding: when both Supabase and Pages LKG retrieval fail, a non-empty crawl must NOT pass.
        final, rep = run(catalog({'qnb_ms': 9, 'qnb_card': 12, 'wings': 3, 'teb_general': 4}), lkg=None)
        self.assertEqual(rep['verdict'], 'rejected'); self.assertFalse(rep['publish']); self.assertFalse(rep['deploy'])
        self.assertIsNone(final)
        self.assertTrue(any('allow_bootstrap' in r for r in rep['reasons']))

    def test_no_lkg_publishes_only_with_explicit_bootstrap_override(self):
        final, rep = cg.evaluate(catalog({'qnb_ms': 2}), None, crawl_ok=True, today=TODAY, keys=KEYS, allow_bootstrap=True)
        self.assertEqual(rep['verdict'], 'bootstrap'); self.assertTrue(rep['publish']); self.assertTrue(rep['deploy'])
        self.assertEqual(rep['baseline'], 'none'); self.assertEqual(len(final['campaigns']), 2)
        # Even with the override, an empty / failed crawl is still rejected and nothing is deployed.
        final, rep = cg.evaluate(catalog({}), None, crawl_ok=True, today=TODAY, keys=KEYS, allow_bootstrap=True)
        self.assertEqual(rep['verdict'], 'rejected'); self.assertIsNone(final); self.assertFalse(rep['deploy'])
        final, rep = cg.evaluate(catalog({'qnb_ms': 2}), None, crawl_ok=False, today=TODAY, keys=KEYS, allow_bootstrap=True)
        self.assertEqual(rep['verdict'], 'rejected'); self.assertFalse(rep['deploy'])

    def test_bootstrap_override_env_parsing(self):
        for v, want in [('1', True), ('true', True), ('', False), ('0', False), ('false', False)]:
            with patch.dict('os.environ', {cg.BOOTSTRAP_ENV: v}):
                self.assertEqual(cg.bootstrap_allowed(), want, v)

    def test_rejected_with_lkg_still_deploys_lkg(self):
        final, rep = run(catalog({'qnb_ms': 1}))
        self.assertEqual(rep['verdict'], 'rejected'); self.assertTrue(rep['deploy']); self.assertIs(final, LKG)

    def test_bootstrap_catalog_is_not_a_valid_baseline(self):
        self.assertFalse(cg.is_valid_catalog({'campaigns': [1], 'meta': {'bootstrap': True}}))


class GuardFileFlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.patches = [patch.object(cg, 'DATA_DIR', self.tmp), patch.object(cg, 'CATALOG_FILE', self.tmp / 'catalog.json'),
                        patch.object(cg, 'LKG_FILE', self.tmp / 'catalog_lkg.json'), patch.object(cg, 'VERDICT_FILE', self.tmp / 'catalog_guard.json'),
                        patch.object(cg, 'source_keys', lambda: KEYS), patch.object(cg, 'today_tr', lambda: TODAY)]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in self.patches: p.stop()

    def test_fetch_lkg_picks_newest_valid_and_seeds_crawler(self):
        older = catalog({'qnb_ms': 3}, gen='2026-09-29T05:00:00+00:00')
        newer = catalog({'qnb_ms': 4}, gen='2026-09-30T15:00:00+00:00')
        def fake(url, headers=None, timeout=25):
            return [{'payload': older}] if 'supabase' in url else newer
        with patch.dict('os.environ', {'SUPABASE_URL': 'https://x.supabase.co', 'SUPABASE_PUBLISHABLE_KEY': 'sb_publishable_x', 'GITHUB_REPOSITORY': 'Melih/Campaign-Hunter', 'PAGES_CATALOG_URL': ''}), \
             patch.object(cg, 'http_json', side_effect=fake) as h:
            self.assertEqual(cg.cmd_fetch_lkg(), 0)
            urls = [c.args[0] for c in h.call_args_list]
        self.assertIn('https://melih.github.io/Campaign-Hunter/data/catalog.json', urls)
        seeded = json.loads((self.tmp / 'catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(seeded['generatedAt'], newer['generatedAt']); self.assertEqual(seeded['meta']['lkgSource'], 'pages')
        self.assertTrue((self.tmp / 'catalog_lkg.json').exists())

    def test_fetch_lkg_network_failure_is_tolerated(self):
        with patch.dict('os.environ', {'SUPABASE_URL': 'https://x.supabase.co', 'SUPABASE_PUBLISHABLE_KEY': 'k', 'GITHUB_REPOSITORY': 'a/b'}), \
             patch.object(cg, 'http_json', side_effect=OSError('down')):
            self.assertEqual(cg.cmd_fetch_lkg(), 0)
        self.assertFalse((self.tmp / 'catalog_lkg.json').exists())

    def test_evaluate_rejected_writes_lkg_and_blocks_publish(self):
        (self.tmp / 'catalog_lkg.json').write_text(json.dumps(LKG), encoding='utf-8')
        (self.tmp / 'catalog.json').write_text(json.dumps(catalog({'qnb_ms': 1})), encoding='utf-8')
        out = self.tmp / 'gh_out'
        with patch.dict('os.environ', {'GITHUB_OUTPUT': str(out)}):
            cg.cmd_evaluate('success')
        final = json.loads((self.tmp / 'catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(final['generatedAt'], LKG['generatedAt'])
        self.assertEqual(final['meta']['guard']['verdict'], 'rejected')
        self.assertIn('verdict=rejected', out.read_text())
        ok, why = ps.guard_allows_publish(self.tmp / 'catalog_guard.json')
        self.assertFalse(ok); self.assertIn('rejected', why)


    def test_evaluate_without_lkg_blocks_deploy_and_publish(self):
        (self.tmp / 'catalog.json').write_text(json.dumps(catalog({'qnb_ms': 9, 'qnb_card': 12})), encoding='utf-8')
        out = self.tmp / 'gh_out'
        with patch.dict('os.environ', {'GITHUB_OUTPUT': str(out), cg.BOOTSTRAP_ENV: ''}):
            cg.cmd_evaluate('success')
        self.assertFalse((self.tmp / 'catalog.json').exists())  # nothing for the copy/deploy step
        text = out.read_text()
        self.assertIn('verdict=rejected', text); self.assertIn('deploy=false', text); self.assertIn('publish=false', text)
        self.assertFalse(ps.guard_allows_publish(self.tmp / 'catalog_guard.json')[0])

    def test_evaluate_without_lkg_with_bootstrap_env_publishes(self):
        (self.tmp / 'catalog.json').write_text(json.dumps(catalog({'qnb_ms': 3})), encoding='utf-8')
        out = self.tmp / 'gh_out'
        with patch.dict('os.environ', {'GITHUB_OUTPUT': str(out), cg.BOOTSTRAP_ENV: '1'}):
            cg.cmd_evaluate('success')
        self.assertIn('deploy=true', out.read_text())
        self.assertTrue(ps.guard_allows_publish(self.tmp / 'catalog_guard.json')[0])


class CrawlerLkgIntegrationTests(unittest.TestCase):
    def test_seeded_lkg_is_preserved_when_source_fails(self):
        tmp = Path(tempfile.mkdtemp())
        lkg = {'version': 1, 'generatedAt': '2026-09-30T15:00:00+00:00', 'meta': {'partial': False},
               'campaigns': [camp('wings', i) for i in range(3)]}
        (tmp / 'catalog.json').write_text(json.dumps(lkg), encoding='utf-8')
        src = [{'key': 'wings', 'bank': 'Akbank', 'card_products': ['akbank-wings-black'], 'fallback_urls': ['https://bank/wings/0']}]
        with patch.object(cc, 'DATA_DIR', tmp), patch.object(cc, 'CATALOG_FILE', tmp / 'catalog.json'), patch.object(cc, 'STAGING_FILE', tmp / 's.json'), \
             patch.object(cc, 'RAW_DIR', tmp / 'raw'), patch.object(cc, 'STATUS_FILE', tmp / 'st.json'), patch.object(cc, 'LOCK_FILE', tmp / 'l.lock'), \
             patch.object(cc, 'load_config', lambda: src), patch.object(cc, 'discover_category_hints', lambda s: ({}, [])), \
             patch.object(cc, 'fetch', side_effect=OSError('blocked')):
            out = cc.refresh_catalog()
        # The crawler alone only keeps the LKG copy of the URL it failed to fetch...
        self.assertGreaterEqual(len(out['campaigns']), 1)
        self.assertTrue(all(c.get('staleFromLastKnownGood') for c in out['campaigns']))
        # ...so the guard must not publish it as a fresh crawl; the full LKG (3 records) stays live.
        final, rep = cg.evaluate(out, lkg, crawl_ok=True, today=TODAY, keys=['wings'])
        self.assertEqual(rep['verdict'], 'rejected')
        self.assertEqual(len(final['campaigns']), 3)


class CrystalOfficialSourceCrawlerTests(unittest.TestCase):
    CRYSTAL_URL = 'https://www.crystalcard.com.tr/crystal-dunyasi/yurtici-anlasmali-otel-and-restoran-indirimleri'

    def test_crystal_official_site_is_a_configured_source(self):
        src = [s for s in cc.load_config() if s['key'] == 'crystal_special'][0]
        self.assertIn(self.CRYSTAL_URL, src['fallback_urls'])
        self.assertIn('www.crystalcard.com.tr', src['domains'])

    def test_crystal_official_page_end_date_is_observed(self):
        from datetime import date
        src = [s for s in cc.load_config() if s['key'] == 'crystal_special'][0]
        body = '<html><h1>Yurtiçi Anlaşmalı Otel ve Restoran İndirimleri</h1><div>Crystal sahipleri seçkin otel ve restoranlarda %20 indirim. Kampanya 31.10.2026 tarihine kadar geçerlidir.</div></html>'.encode()
        c = cc.generic_parse(src, self.CRYSTAL_URL, body, date(2026, 10, 3)) or cc.known_core_fallback(src, self.CRYSTAL_URL, body, date(2026, 10, 3))
        self.assertIsNotNone(c)
        self.assertEqual(c['sourceUrl'], self.CRYSTAL_URL); self.assertEqual(c['bank'], 'Yapı Kredi')
        self.assertEqual(c['endDate'], '2026-10-31')

    def test_single_end_date_phrases(self):
        from datetime import date
        d = date(2026, 10, 3)
        self.assertEqual(cc.parse_date_range('31.10.2026 tarihine kadar geçerlidir', d), (None, '2026-10-31'))
        self.assertEqual(cc.parse_date_range("31.10.2026'ya kadar", d), (None, '2026-10-31'))
        self.assertEqual(cc.parse_date_range('30 Eylül 2026 tarihine kadar', d), (None, '2026-09-30'))
        self.assertEqual(cc.parse_date_range('01.10.2026 - 31.10.2026', d), ('2026-10-01', '2026-10-31'))


class CrystalExplicitValidityTests(unittest.TestCase):
    URL = 'https://www.crystalcard.com.tr/crystal-dunyasi/yurtici-anlasmali-otel-and-restoran-indirimleri'
    PAGE = (
        '<html><head><title>Yurtiçi Anlaşmalı Otel ve Restoran İndirimleri</title>'
        '<script>var promo="01.01.2027 - 31.12.2027";</script></head><body>'
        '<h1>Yurtiçi Anlaşmalı Otel ve Restoran İndirimleri</h1>'
        '<p>Crystal sahipleri seçkin otel ve restoranlarda %20 indirim ile ayrıcalıklıdır.</p>'
        '<div class="list"><h3>İstanbul</h3><p>Yeni restoranlar 01.09.2026 - 30.09.2026 tarihleri arasında listeye eklendi.</p>'
        '<p>Ali Ocakbaşı · Beyti · Da Mario</p></div>'
        '<details><summary>Kampanya Koşulları</summary><p>Aylık en fazla 3.000 / 5.000 / 7.500 / 10.000 TL indirim. '
        'Metal Crystal ve Crystal kartlarına birlikte sahip müşteriler kartlar toplamında aylık en fazla 15.000 TL indirim kazanabilir. '
        'İndirimler 31.10.2026 tarihine kadar geçerlidir.</p></details></body></html>'
    ).encode('utf-8')

    def setUp(self):
        from datetime import date
        self.today = date(2026, 10, 3)
        self.src = [s for s in cc.load_config() if s['key'] == 'crystal_special'][0]

    def test_official_crystal_page_end_date_parsed_directly(self):
        c = cc.generic_parse(self.src, self.URL, self.PAGE, self.today) or cc.known_core_fallback(self.src, self.URL, self.PAGE, self.today)
        self.assertIsNotNone(c)
        self.assertEqual(c['endDate'], '2026-10-31')  # explicit sentence beats the earlier listing date range
        self.assertEqual(c['sourceUrl'], self.URL)

    def test_core_fallback_path_also_uses_explicit_sentence(self):
        c = cc.known_core_fallback(self.src, self.URL, self.PAGE, self.today)
        self.assertEqual(c['endDate'], '2026-10-31')
        self.assertIsNone(c['startDate'])  # the listing range start (01.09) must not leak in as validity start

    def test_explicit_sentence_variants(self):
        self.assertEqual(cc.explicit_validity_end('İndirimler 31.10.2026 tarihine kadar geçerlidir.'), '2026-10-31')
        self.assertEqual(cc.explicit_validity_end('İndirimler\xa031.10.2026\xa0tarihine kadar geçerlidir'), '2026-10-31')
        self.assertEqual(cc.explicit_validity_end("Kampanya 31.10.2026'ya kadar geçerlidir"), '2026-10-31')
        self.assertIsNone(cc.explicit_validity_end('Kampanya kapsamında kazanılan puanlar 15.11.2026 tarihine kadar geçerlidir'))
        self.assertIsNone(cc.explicit_validity_end('var x="İndirimler"'))

    def test_explicit_sentence_only_overrides_on_core_source_pages(self):
        text = 'Kampanya 01.10.2026 - 15.10.2026 tarihleri arasında. İndirimler 31.10.2026 tarihine kadar geçerlidir.'
        self.assertEqual(cc.core_source_dates('https://bank.example/kampanyalar/x', text, self.today), ('2026-10-01', '2026-10-15'))
        self.assertEqual(cc.core_source_dates(self.URL, text, self.today), (None, '2026-10-31'))  # unrelated range start dropped
        same = 'Kampanya 01.10.2026 - 31.10.2026 tarihleri arasında. İndirimler 31.10.2026 tarihine kadar geçerlidir.'
        self.assertEqual(cc.core_source_dates(self.URL, same, self.today), ('2026-10-01', '2026-10-31'))  # consistent range keeps start

    def test_script_text_is_not_used_as_validity(self):
        page = '<html><h1>Yurtiçi Anlaşmalı Otel ve Restoran İndirimleri</h1><script>x="İndirimler 31.12.2027 tarihine kadar geçerlidir"</script><p>Crystal ile anlaşmalı restoranlarda %20 indirim. Liste aşağıdadır ve düzenli güncellenir; şubeler değişebilir.</p></html>'.encode('utf-8')
        c = cc.known_core_fallback(self.src, self.URL, page, self.today)
        self.assertIsNone(c['endDate'])

    def test_live_observation_feeds_official_source_record(self):
        c = cc.known_core_fallback(self.src, self.URL, self.PAGE, self.today)
        self.assertEqual(c['bank'], 'Yapı Kredi'); self.assertFalse(c.get('staleFromLastKnownGood', False))


class IstanbulCalendarTests(unittest.TestCase):
    def test_crawler_and_guard_use_istanbul_date_not_runner_utc(self):
        # 2026-09-30T21:05Z is already 1 October 00:05 in Istanbul.
        from datetime import datetime as real_dt, timezone as tzmod
        class FakeDT(real_dt):
            @classmethod
            def now(cls, tz=None):
                base = real_dt(2026, 9, 30, 21, 5, tzinfo=tzmod.utc)
                return base.astimezone(tz) if tz else base.replace(tzinfo=None)
        with patch.object(cc, 'datetime', FakeDT), patch.object(cg, 'datetime', FakeDT):
            self.assertEqual(cc.today_tr().isoformat(), '2026-10-01')
            self.assertEqual(cg.today_tr(), '2026-10-01')


class WorkflowFailClosedTests(unittest.TestCase):
    def test_workflow_wires_lkg_guard_and_fail_closed_deploy(self):
        wf = (Path(__file__).resolve().parents[2] / '.github' / 'workflows' / 'pwa-pages.yml').read_text(encoding='utf-8')
        self.assertLess(wf.index('catalog_guard.py fetch-lkg'), wf.index('campaign_crawler.py'))
        self.assertLess(wf.index('campaign_crawler.py'), wf.index('catalog_guard.py evaluate'))
        self.assertIn("steps.guard.outputs.deploy != 'true'", wf)
        self.assertLess(wf.index("steps.guard.outputs.deploy != 'true'"), wf.index('cp server/data/catalog.json web/data/catalog.json'))
        # Bootstrap override only from an explicit manual run input, never from a persistent variable.
        self.assertIn("CATALOG_GUARD_ALLOW_BOOTSTRAP: ${{ github.event_name == 'workflow_dispatch' && inputs.allow_bootstrap && '1' || '' }}", wf)
        self.assertNotIn('vars.CATALOG_GUARD_ALLOW_BOOTSTRAP', wf)

    def test_workflow_runs_tests_in_utc_and_istanbul_before_build(self):
        wf = (Path(__file__).resolve().parents[2] / '.github' / 'workflows' / 'pwa-pages.yml').read_text(encoding='utf-8')
        self.assertIn('  test:\n', wf); self.assertIn('    needs: test\n', wf)
        self.assertLess(wf.index('  test:\n'), wf.index('  build:\n'))
        self.assertIn('TZ: UTC', wf); self.assertIn('TZ: Europe/Istanbul', wf)
        self.assertIn('working-directory: web', wf); self.assertIn('run: npm test', wf)
        self.assertIn('node e2e/ui-smoke.mjs', wf)
        self.assertIn('node e2e/account-smoke.mjs', wf)
        self.assertIn('postgresql', wf)
        runner = (Path(__file__).resolve().parents[2] / 'web' / 'run-tests.mjs').read_text(encoding='utf-8')
        self.assertIn('UTC', runner); self.assertIn('Europe/Istanbul', runner)


class PublishSupabaseTests(unittest.TestCase):
    def test_body_refreshes_updated_at(self):
        now = datetime(2026, 10, 1, 5, 0, tzinfo=timezone.utc)
        body = ps.build_body({'campaigns': []}, now)
        self.assertEqual(body['updated_at'], now.isoformat()); self.assertEqual(body['id'], 1)

    def test_rejected_verdict_skips_network_publish(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / 'catalog_guard.json').write_text(json.dumps({'verdict': 'rejected', 'publish': False, 'reasons': ['x']}), encoding='utf-8')
        with patch.object(ps, 'VERDICT', tmp / 'catalog_guard.json'), patch.dict('os.environ', {'SUPABASE_URL': 'https://x', 'SUPABASE_SECRET_KEY': 's'}), \
             patch.object(ps, 'urlopen') as u:
            self.assertEqual(ps.main(), 0)
            u.assert_not_called()

    def test_ok_verdict_publishes_with_updated_at(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / 'catalog_guard.json').write_text(json.dumps({'verdict': 'ok', 'publish': True}), encoding='utf-8')
        (tmp / 'catalog.json').write_text(json.dumps(catalog({'qnb_ms': 2})), encoding='utf-8')
        class R:
            status = 201
            def __enter__(self): return self
            def __exit__(self, *a): return False
        with patch.object(ps, 'VERDICT', tmp / 'catalog_guard.json'), patch.object(ps, 'CATALOG', tmp / 'catalog.json'), \
             patch.dict('os.environ', {'SUPABASE_URL': 'https://x', 'SUPABASE_SECRET_KEY': 's'}), patch.object(ps, 'urlopen', return_value=R()) as u:
            self.assertEqual(ps.main(), 0)
            sent = json.loads(u.call_args.args[0].data.decode('utf-8'))
        self.assertIn('updated_at', sent)


if __name__ == '__main__':
    unittest.main()
