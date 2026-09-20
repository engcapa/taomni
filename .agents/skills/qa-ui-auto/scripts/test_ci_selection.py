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
