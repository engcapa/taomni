import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from qa_ui_auto.ci import dependency_order, diff_paths, make_plan, selection_entry, write_json


def args(**overrides):
    return argparse.Namespace(**({'scope': 'smoke', 'head': '', 'base': '',
        'platforms': 'linux,windows,macos', 'modes': 'browser,native',
        'case_ids': '', 'features': '', 'tags': ''} | overrides))


class SelectionTests(unittest.TestCase):
    def test_smoke_expands_to_six_real_combinations(self):
        plan = make_plan(args())
        self.assertEqual(len(plan['entries']), 6)
        self.assertEqual({e['arch'] for e in plan['entries']}, {'ARM64', 'X64'})
        self.assertTrue(all(e['selected_ids'] for e in plan['entries']))

    def test_restore_pulls_predecessor_before_it(self):
        cid = 'TC-auto-F-DB-1-query-tab-rename-native-restore'
        plan = make_plan(args(scope='selected', case_ids=cid, modes='native'))
        for entry in plan['entries']:
            self.assertEqual(entry['selected_ids'], [cid.removesuffix('-restore'), cid])
            self.assertIn('mysql', entry['capabilities'])

    def test_ard_case_runs_only_natively_on_macos_with_screen_sharing(self):
        plan = make_plan(args(scope='selected', case_ids='TC-152'))
        self.assertEqual([e['id'] for e in plan['entries']], ['macos-native'])
        self.assertIn('ard', plan['entries'][0]['capabilities'])
        reasons = {(n['platform'], n['mode']) for n in plan['not_applicable'] if n['case'] == 'TC-152'}
        self.assertEqual(reasons, {('linux', 'browser'), ('linux', 'native'), ('windows', 'browser'),
                                   ('windows', 'native'), ('macos', 'browser')})

    def test_vnc_fixture_case_requests_the_vnc_service_everywhere(self):
        plan = make_plan(args(scope='selected', case_ids='TC-151'))
        self.assertEqual(len(plan['entries']), 6)
        for entry in plan['entries']:
            self.assertEqual(entry['selected_ids'], ['TC-151'])
            self.assertIn('vnc', entry['capabilities'])

    def test_external_project_is_reported_as_gap_and_explicit_selection_fails(self):
        cid = 'TC-IDE-C6-06-java-definition-realproject-native'
        plan = make_plan(args(scope='all', modes='native'))
        gaps = [gap for gap in plan['gaps'] if gap['case'] == cid]
        self.assertEqual({gap['platform'] for gap in gaps}, {'linux', 'windows', 'macos'})
        self.assertTrue(all('QA_JAVA_PROJECT_ROOT' in gap['reason'] for gap in gaps))
        self.assertTrue(all(cid not in entry['selected_ids'] for entry in plan['entries']))
        with self.assertRaisesRegex(ValueError, 'explicit cases unavailable'):
            make_plan(args(scope='selected', case_ids=cid, modes='native'))

    def test_unknown_empty_and_wrong_platform_requests_fail(self):
        for override in ({'scope':'selected'}, {'scope':'selected','case_ids':'TC-NOT-REAL'},
                         {'scope':'impacted'}, {'platforms':'self-hosted'},
                         {'scope':'smoke','case_ids':'TC-001'}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                make_plan(args(**override))

    def test_dependency_cycles_and_unknown_dependencies_fail(self):
        with self.assertRaisesRegex(ValueError, 'cycle'):
            dependency_order({'A'}, {'A':['B'], 'B':['A']}, {'A','B'})
        with self.assertRaisesRegex(ValueError, 'unknown'):
            dependency_order({'A'}, {'A':['C']}, {'A'})

    def test_manifest_rejects_tampered_case_digest(self):
        plan = make_plan(args(platforms='linux', modes='browser'))
        plan['entries'][0]['case_digests']['TC-001'] = 'wrong'
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/'selection.json'
            write_json(path, plan)
            with self.assertRaisesRegex(ValueError, 'case changed'):
                selection_entry(path, 'linux-browser')

    def test_git_diff_preserves_both_rename_paths_and_deletion(self):
        original = Path.cwd()
        with tempfile.TemporaryDirectory() as d:
            try:
                os.chdir(d)
                def git(*a):
                    return subprocess.check_output(['git', *a], stderr=subprocess.DEVNULL).decode().strip()
                git('init'); git('config','user.email','qa@example.invalid'); git('config','user.name','QA')
                Path('old.txt').write_text('preserve rename contents\n'*10)
                Path('deleted.txt').write_text('gone')
                git('add','.'); git('commit','-qm','base'); base=git('rev-parse','HEAD')
                Path('old.txt').rename('new.txt'); Path('deleted.txt').unlink()
                git('add','-A'); git('commit','-qm','candidate')
                _, paths=diff_paths(base,git('rev-parse','HEAD'))
                self.assertEqual(paths,['deleted.txt','new.txt','old.txt'])
            finally:
                os.chdir(original)
