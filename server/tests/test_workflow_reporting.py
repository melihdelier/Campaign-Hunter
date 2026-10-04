"""v1.5.0: the catalog guard's GitHub Actions reporting.

- In production (no CATALOG_GUARD_ACTIONS_REPORTING override) a rejected crawl still writes the step summary and an
  ::error:: workflow command, exactly as before.
- Unit tests that deliberately run rejected/bootstrap fixtures set CATALOG_GUARD_ACTIONS_REPORTING=0, so the green test
  job's summary/annotations are not polluted with production-looking "rejected" messages.
Workflow commands produced here are captured (redirect_stdout), never printed to the CI log.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalog_guard as cg

ROOT = Path(__file__).resolve().parents[2]
LKG = {'version': 1, 'generatedAt': '2026-09-30T15:10:00+00:00', 'meta': {'partial': False},
       'campaigns': [{'id': f'c{i}', 'sourceKey': 'wings', 'sourceUrl': f'https://b/{i}', 'endDate': '2026-12-31', 'sourceKind': 'official_web'} for i in range(12)]}


class ActionsReportingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / 'catalog_lkg.json').write_text(json.dumps(LKG), encoding='utf-8')
        (self.tmp / 'catalog.json').write_text(json.dumps({'version': 1, 'generatedAt': '2026-10-01T05:00:00+00:00', 'campaigns': [], 'meta': {'partial': False}}), encoding='utf-8')
        self.patches = [patch.object(cg, 'CATALOG_FILE', self.tmp / 'catalog.json'), patch.object(cg, 'LKG_FILE', self.tmp / 'catalog_lkg.json'),
                        patch.object(cg, 'VERDICT_FILE', self.tmp / 'v.json')]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in self.patches: p.stop()

    def run_evaluate(self, env):
        buf = io.StringIO()
        with patch.dict(os.environ, env, clear=False), contextlib.redirect_stdout(buf):
            cg.cmd_evaluate('failure')
        return buf.getvalue()

    def test_production_rejection_still_surfaces(self):
        summary = self.tmp / 'summary.md'
        out = self.run_evaluate({cg.ACTIONS_REPORTING_ENV: '1', 'GITHUB_STEP_SUMMARY': str(summary)})
        self.assertIn('::error::Katalog kalite kapısı yeni taramayı reddetti', out)
        self.assertIn('Katalog kalite kapısı: `rejected`', summary.read_text(encoding='utf-8'))

    def test_default_without_override_is_production_behaviour(self):
        summary = self.tmp / 'summary.md'
        env = {'GITHUB_STEP_SUMMARY': str(summary)}
        with patch.dict(os.environ, env):
            os.environ.pop(cg.ACTIONS_REPORTING_ENV, None)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                cg.cmd_evaluate('failure')
        self.assertIn('::error::', buf.getvalue())
        self.assertTrue(summary.exists())

    def test_test_mode_does_not_pollute_summary_or_annotations(self):
        summary = self.tmp / 'summary.md'
        out = self.run_evaluate({cg.ACTIONS_REPORTING_ENV: '0', 'GITHUB_STEP_SUMMARY': str(summary)})
        self.assertFalse(summary.exists(), 'no step summary written from test fixtures')
        self.assertNotIn('::error::', out); self.assertNotIn('::warning::', out)
        self.assertIn('ERROR: Katalog kalite kapısı yeni taramayı reddetti', out, 'message still assertable internally')
        verdict = json.loads((self.tmp / 'v.json').read_text(encoding='utf-8'))
        self.assertEqual(verdict['verdict'], 'rejected', 'the guard itself is not weakened')

    def test_guard_test_modules_opt_out(self):
        src = (ROOT / 'server' / 'tests' / 'test_catalog_guard.py').read_text(encoding='utf-8')
        self.assertIn("os.environ[cg.ACTIONS_REPORTING_ENV] = '0'", src)
        self.assertIn("os.environ.pop('GITHUB_STEP_SUMMARY', None)", src)
        self.assertNotIn("            cg.cmd_evaluate('success')", src, 'cmd_evaluate in tests must run through quiet()')

    def test_workflow_build_job_runs_real_guard_with_reporting(self):
        wf = (ROOT / '.github' / 'workflows' / 'pwa-pages.yml').read_text(encoding='utf-8')
        self.assertIn('python server/catalog_guard.py evaluate', wf)
        self.assertNotIn(cg.ACTIONS_REPORTING_ENV, wf, 'production guard step must keep Actions reporting on')



class WorkflowStructureTests(unittest.TestCase):
    """Text-level checks (no PyYAML dependency on the CI interpreter)."""

    def test_required_jobs_and_steps_present(self):
        import re
        wf = (ROOT / '.github' / 'workflows' / 'pwa-pages.yml').read_text(encoding='utf-8')
        jobs = re.findall(r'^  ([a-z][a-z-]*):\s*$', wf.split('\njobs:\n', 1)[1], re.M)
        self.assertEqual(jobs, ['test', 'build', 'deploy', 'catalog-health'])
        test_job = wf.split('\n  test:\n', 1)[1].split('\n  build:\n', 1)[0]
        for needle in ('postgresql', 'TZ: UTC', 'TZ: Europe/Istanbul', 'npm test', 'e2e/ui-smoke.mjs', 'e2e/account-smoke.mjs',
                       'e2e/auth-callback-smoke.mjs', 'e2e/v15-smoke.mjs', 'e2e/discovery-smoke.mjs'):
            self.assertIn(needle, test_job)
        for old in ('actions/checkout@v4', 'actions/setup-python@v5', 'actions/setup-node@v4', 'actions/configure-pages@v5',
                    'actions/upload-pages-artifact@v3', 'actions/deploy-pages@v4', "node-version: '20'"):
            self.assertNotIn(old, wf, 'Node 20 action majors replaced')
        self.assertEqual(re.findall(r'runs-on: (\S+)', wf), ['ubuntu-24.04'] * 4)
        self.assertIn('needs: test', wf)


if __name__ == '__main__':
    unittest.main()
