import argparse
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from qa_ui_auto.ci import capabilities, dependency_order, diff_paths, make_plan, selection_entry, write_json
from qa_ui_auto.linux_profiles import DEFAULT_LINUX_PROFILE, LINUX_PROFILES


def args(**overrides):
    return argparse.Namespace(**({'scope': 'smoke', 'head': '', 'base': '',
        'platforms': 'linux,windows,macos', 'modes': 'browser,native',
        'case_ids': '', 'features': '', 'tags': ''} | overrides))


class SelectionTests(unittest.TestCase):
    def test_release_override_changes_only_native_build_capability_not_case_selection(self):
        selection = dict(scope="selected", platforms="linux", modes="browser,native",
                         case_ids="TC-SHOT-N20,TC-SHOT-036")
        default = make_plan(args(**selection))
        release = make_plan(args(**selection, native_release=True))
        self.assertFalse(default["native_release"])
        self.assertTrue(release["native_release"])
        self.assertEqual(default["gaps"], release["gaps"])
        for before, after in zip(default["entries"], release["entries"]):
            self.assertEqual(before["id"], after["id"])
            self.assertEqual(before["selected_ids"], after["selected_ids"])
            self.assertNotIn("release", before["capabilities"])
            expected = set(before["capabilities"]) | ({"release"} if before["mode"] == "native" else set())
            self.assertEqual(set(after["capabilities"]), expected)

    def test_only_mstsc_cases_require_windows_debugger_tools(self):
        client = SimpleNamespace(fixtures=["rdp_server_required"], steps=[{"open": "/"}], tags=[])
        self.assertNotIn("mstsc", capabilities([client], "native"))
        client.steps.append({"host_mstsc": {"action": "start"}})
        self.assertIn("mstsc", capabilities([client], "native"))
        self.assertNotIn("mstsc", capabilities([client], "browser"))

    def test_rdp_contracts_run_once_in_selected_linux_profiles(self):
        plan = make_plan(args(scope="selected", case_ids="TC-RDPJ-02-joint-clipboard-no-echo",
                              modes="native", linux_profiles=",".join(LINUX_PROFILES)))
        owners = [e for e in plan["entries"] if e["rdp_unit_contracts"]]
        self.assertEqual(len(owners), 1)
        self.assertEqual(owners[0]["id"], "linux-native")
        plan = make_plan(args(scope="selected", case_ids="TC-RDPJ-02-joint-clipboard-no-echo",
                              platforms="linux", modes="native", linux_profiles="ubuntu-22.04-vnc"))
        self.assertTrue(plan["entries"][0]["rdp_unit_contracts"])

    def test_smoke_expands_to_six_real_combinations(self):
        plan = make_plan(args())
        self.assertEqual(len(plan['entries']), 6)
        self.assertEqual({e['arch'] for e in plan['entries']}, {'ARM64', 'X64'})
        self.assertTrue(all(e['selected_ids'] for e in plan['entries']))
        linux = next(e for e in plan['entries'] if e['id'] == 'linux-native')
        self.assertEqual(linux['runner'], 'ubuntu-24.04')
        self.assertEqual(linux['linux_profile'], DEFAULT_LINUX_PROFILE)
        self.assertEqual(linux['cache_key'], 'linux')

    def test_multiple_linux_profiles_expand_only_native_and_deduplicate(self):
        plan = make_plan(args(platforms='linux', linux_profiles=','.join(LINUX_PROFILES) + ',ubuntu-22.04-vnc'))
        browser = [e for e in plan['entries'] if e['mode'] == 'browser']
        native = [e for e in plan['entries'] if e['mode'] == 'native']
        self.assertEqual([e['id'] for e in browser], ['linux-browser'])
        self.assertEqual({e['linux_profile'] for e in native}, set(LINUX_PROFILES))
        self.assertEqual(len({e['id'] for e in native}), 4)
        self.assertEqual({e['runner'] for e in native}, {'ubuntu-22.04', 'ubuntu-24.04', 'ubuntu-26.04'})
        self.assertTrue(all(e['selected_ids'] == ['TC-NATIVE-CORE-001'] for e in native))

    def test_only_selected_profile_runs_without_implicit_default(self):
        plan = make_plan(args(platforms='linux', modes='native', linux_profiles='ubuntu-22.04-vnc'))
        self.assertEqual(len(plan['entries']), 1)
        entry = plan['entries'][0]
        self.assertEqual(entry['linux_profile'], 'ubuntu-22.04-vnc')
        self.assertEqual(entry['linux_wrapper'], 'dbus')
        self.assertEqual(entry['desktop']['display_server'], 'Xtigervnc')

    def test_native_window_case_is_selected_on_both_linux_desktops(self):
        plan = make_plan(args(scope='selected', platforms='linux', modes='native',
                              linux_profiles='ubuntu-24.04-xvfb,ubuntu-26.04-wayland',
                              case_ids='TC-MAIN-RAIL-03,TC-NATIVE-CORE-001'))
        wayland = next(e for e in plan['entries'] if e['linux_profile'] == 'ubuntu-26.04-wayland')
        self.assertEqual(set(wayland['selected_ids']), {'TC-NATIVE-CORE-001', 'TC-MAIN-RAIL-03'})
        self.assertFalse(plan['gaps'])

    def test_dual_display_x11_selection_binds_owned_xorg_identity(self):
        plan = make_plan(args(scope='selected', platforms='linux', modes='native',
                              linux_profiles=','.join(LINUX_PROFILES),
                              case_ids='TC-SHOT-N23'))
        for entry in plan['entries']:
            if entry['linux_profile'] == 'ubuntu-26.04-wayland':
                self.assertEqual(entry['desktop']['display_server'], 'Mutter')
            else:
                self.assertEqual(entry['desktop']['display_server'], 'Xorg dummy')

    def test_full_wayland_native_selection_matches_x11_case_ids(self):
        plan = make_plan(args(scope='all', platforms='linux', modes='native',
                              linux_profiles='ubuntu-24.04-xvfb,ubuntu-26.04-wayland'))
        x11, wayland = plan['entries']
        self.assertEqual(x11['selected_ids'], wayland['selected_ids'])
        # The user's external project remains unavailable on both desktops.
        self.assertEqual([(g['case'], g['linux_profile']) for g in plan['gaps']], [
            ('TC-IDE-C6-06-java-definition-realproject-native', 'ubuntu-24.04-xvfb'),
            ('TC-IDE-C6-06-java-definition-realproject-native', 'ubuntu-26.04-wayland')])

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

    def test_updater_cases_select_only_macos_native_and_real_updater_capability(self):
        plan = make_plan(args(scope='selected', case_ids='TC-UPDATE-MACOS-001,TC-UPDATE-MACOS-002'))
        self.assertEqual([e['id'] for e in plan['entries']], ['macos-native'])
        entry = plan['entries'][0]
        self.assertEqual(entry['selected_ids'], ['TC-UPDATE-MACOS-001', 'TC-UPDATE-MACOS-002'])
        self.assertIn('updater', entry['capabilities'])
        self.assertEqual(plan['gaps'], [])

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
                         {'linux_profiles':'ubuntu-latest'},
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
