import argparse
from contextlib import ExitStack
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ci_plan_test_support import repository_plan_snapshot
from qa_ui_auto.ci import capabilities, dependency_order, diff_paths, make_plan, selection_entry, write_json
from qa_ui_auto.linux_profiles import DEFAULT_LINUX_PROFILE, LINUX_PROFILES


def setUpModule():
    inputs = ExitStack()
    unittest.addModuleCleanup(inputs.close)
    inputs.enter_context(repository_plan_snapshot(Path.cwd()))


def args(**overrides):
    return argparse.Namespace(**({'scope': 'smoke', 'head': '', 'base': '',
        'platforms': 'linux,windows,macos', 'modes': 'browser,native',
        'case_ids': '', 'features': '', 'tags': '', 'shards': '1'} | overrides))


class ModuleProfileSelectionTests(unittest.TestCase):
    def test_both_installation_states_preserve_applicable_crash_cases(self):
        options = dict(scope="selected", tags="crash-regression", native_release=True, shards="3")
        core = make_plan(args(**options, module_profile="core-only"))
        full = make_plan(args(**options, module_profile="full", first_release_run="123"))
        self.assertEqual(core["module_profile"]["modules"], {})
        self.assertEqual(len(full["module_profile"]["modules"]), 10)
        self.assertEqual(core["gaps"], [])
        self.assertEqual(full["gaps"], [])
        self.assertEqual([b["id"] for b in core["builds"]], [b["id"] for b in full["builds"]])
        self.assertTrue(all(b["id"].endswith("-release-modular") for b in full["builds"]))
        self.assertTrue(all("modular-release" in b["capabilities"] for b in full["builds"]))
        common_mode_cases = {"TC-FILE-OPEN-049": "mail", "TC-MODULES-102": "mfa"}
        browser_cases = {"TC-TAOFFICE-033": "taoffice-pdf", "TC-TAOFFICE-039": "taoffice-ppt",
                         "TC-TAOFFICE-041": "taoffice-visio", "TC-TAOFFICE-043": "taoffice-video",
                         "TC-TAOFFICE-044": "taoffice-video"}
        native_cases = {"TC-TAOFFICE-034": "taoffice-pdf", "TC-TAOFFICE-040": "taoffice-ppt",
                        "TC-TAOFFICE-042": "taoffice-visio", "TC-TAOFFICE-045": "taoffice-video",
                        "TC-TAOFFICE-046": "taoffice-video"}
        plugin_cases = {**common_mode_cases, **browser_cases, **native_cases}
        excludes = [entry for entry in core["not_applicable"] if "requires_plugin" in entry]
        self.assertEqual(len(excludes), 42)
        self.assertEqual({e["case"]: e["requires_plugin"] for e in excludes}, plugin_cases)
        core_modes = {(e["mode"], e["platform_key"], case) for e in core["entries"] for case in e["selected_ids"]}
        full_modes = {(e["mode"], e["platform_key"], case) for e in full["entries"] for case in e["selected_ids"]}
        self.assertEqual(full_modes - core_modes, {
            (mode, platform, case) for mode in ("browser", "native")
            for platform in ("linux", "windows", "macos")
            for case in common_mode_cases | (browser_cases if mode == "browser" else native_cases)
        })
        self.assertTrue(all((mode, platform, "TC-WS-039") in core_modes
                            for mode in ("browser", "native") for platform in ("linux", "windows", "macos")))
        for entry in full["entries"]:
            self.assertEqual("full-module-profile" in entry["capabilities"], entry["mode"] == "native")
            self.assertNotIn("legacy-mail-imap", entry["capabilities"])

    def test_full_native_profile_requires_a_release_producer(self):
        with self.assertRaisesRegex(ValueError, "matching Release Bundle run ID"):
            make_plan(args(scope="selected", tags="crash-regression", module_profile="full"))

    def test_full_roster_covers_the_native_rdp_performance_case(self):
        performance = "TC-RDPS-PERF-01-performance-budget"
        plan = make_plan(args(scope="selected", tags="crash-regression", module_profile="full",
                              modes="native", first_release_run="123",
                              modular_rdp_p95=True, case_ids=performance))
        entries = [e for e in plan["entries"] if performance in e["selected_ids"]]
        self.assertEqual({e["platform_key"] for e in entries}, {"linux", "windows", "macos"})
        self.assertTrue(all("full-module-profile" in e["capabilities"] for e in entries))
        self.assertTrue(plan["modular_rdp_p95"])


class MacosRunnerSelectionTests(unittest.TestCase):
    def test_macos_26_arm64_recovery_keeps_cases_crash_selection_and_release_architecture(self):
        selected = dict(scope="selected", platforms="macos", modes="native",
                        case_ids="TC-EXPLORER-006,TC-EXPLORER-010,TC-EXPLORER-013,TC-EXPLORER-012,"
                                 "TC-FILE-OPEN-041,TC-MODULES-033,TC-MODULES-034,TC-MODULES-035",
                        tags="crash-regression", native_release=True, shards="4")
        original = make_plan(args(**selected))
        recovery = make_plan(args(**selected, macos_runner="macos-26"))
        self.assertEqual(recovery["groups"], original["groups"])
        self.assertEqual(recovery["gaps"], [])
        self.assertEqual(recovery["unreviewed"], [])
        self.assertEqual(recovery["macos_runner"], "macos-26")
        self.assertEqual({entry["runner"] for entry in recovery["entries"]}, {"macos-26"})
        self.assertEqual({entry["arch"] for entry in recovery["entries"]}, {"ARM64"})
        self.assertEqual(recovery["builds"][0]["id"], "native-build-macos-arm64-release")
        self.assertEqual(recovery["builds"][0]["runner"], "macos-26")
        for before, after in zip(original["entries"], recovery["entries"], strict=True):
            for key in ("selected_ids", "case_digests", "capabilities"):
                self.assertEqual(before[key], after[key])

    def test_macos_intel_keeps_cases_and_separates_native_build_architecture(self):
        selected = dict(scope="selected", platforms="macos", modes="browser,native",
                        case_ids="TC-MODULES-022,TC-MODULES-023", native_release=True)
        arm = make_plan(args(**selected))
        intel = make_plan(args(**selected, macos_runner="macos-15-intel"))
        self.assertEqual(arm["groups"], intel["groups"])
        self.assertEqual(intel["gaps"], [])
        self.assertEqual(intel["macos_runner"], "macos-15-intel")
        self.assertEqual({entry["runner"] for entry in intel["entries"]}, {"macos-15-intel"})
        self.assertEqual({entry["arch"] for entry in intel["entries"]}, {"X64"})
        self.assertEqual(arm["builds"][0]["id"], "native-build-macos-arm64-release")
        self.assertEqual(intel["builds"][0]["id"], "native-build-macos-x64-release")
        for before, after in zip(arm["entries"], intel["entries"]):
            self.assertEqual(before["case_digests"], after["case_digests"])
            self.assertEqual(before["capabilities"], after["capabilities"])

    def test_macos_runner_rejects_unapproved_host_and_architecture_labels(self):
        with self.assertRaisesRegex(ValueError, "macos_runner"):
            make_plan(args(macos_runner="self-hosted"))


class SelectionTests(unittest.TestCase):
    def test_workspace_file_clipboard_selects_only_exact_modes_without_network_services(self):
        plan = make_plan(args(scope="selected", case_ids="TC-WS-089,TC-WS-090"))
        self.assertEqual(len(plan["entries"]), 6)
        self.assertEqual(plan["gaps"], [])
        for entry in plan["entries"]:
            expected = "TC-WS-090" if entry["mode"] == "native" else "TC-WS-089"
            self.assertEqual(entry["selected_ids"], [expected])
            self.assertEqual(entry["capabilities"], ["display"] if entry["mode"] == "native" else [])

    def test_workspace_drop_cases_select_exact_modes_without_extra_services_or_dependencies(self):
        plan = make_plan(args(scope="selected", case_ids="TC-WS-087,TC-WS-088"))
        self.assertEqual(len(plan["entries"]), 6)
        self.assertEqual(plan["gaps"], [])
        for entry in plan["entries"]:
            expected = "TC-WS-088" if entry["mode"] == "native" else "TC-WS-087"
            self.assertEqual(entry["selected_ids"], [expected])
            self.assertEqual(entry["capabilities"], ["display"] if entry["mode"] == "native" else [])

    def test_portable_sftp_lifecycle_uses_posix_without_changing_win32_path_cases(self):
        plan = make_plan(args(scope="selected", case_ids="TC-145"))
        self.assertEqual(len(plan["entries"]), 6)
        for entry in plan["entries"]:
            self.assertIn("ssh_posix", entry["capabilities"])
            self.assertNotIn("ssh", entry["capabilities"])
        retained = make_plan(args(scope="selected", case_ids="TC-010,TC-012"))
        for entry in retained["entries"]:
            self.assertIn("ssh", entry["capabilities"])
            self.assertNotIn("ssh_posix", entry["capabilities"])

    def test_cloud_settings_provision_secret_service_without_protocol_fixture(self):
        plan = make_plan(args(scope="selected", case_ids="TC-BACKUP-CLOUD-001",
                              platforms="linux", modes="native"))
        self.assertEqual(len(plan["entries"]), 1)
        self.assertEqual(plan["entries"][0]["selected_ids"], ["TC-BACKUP-CLOUD-001"])
        self.assertIn("secret-service", plan["entries"][0]["capabilities"])

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
        client = SimpleNamespace(id="TC-RDPJ-02-joint-clipboard-no-echo", fixtures=["rdp_server_required"],
                                 steps=[{"open": "/"}], tags=[])
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
        expected = {'TC-NATIVE-CORE-001', 'TC-WS-038', 'TC-WS-039', 'TC-WS-045', 'TC-WS-051',
                    'TC-WS-052', 'TC-WS-053', 'TC-WS-054', 'TC-WS-056', 'TC-WS-057', 'TC-MOBILE-013',
                    'TC-FILE-OPEN-002', 'TC-FILE-OPEN-003', 'TC-FILE-OPEN-005', 'TC-FILE-OPEN-006',
                    'TC-FILE-OPEN-007', 'TC-FILE-OPEN-008', 'TC-FILE-OPEN-009', 'TC-FILE-OPEN-010', 'TC-FILE-OPEN-011', 'TC-FILE-OPEN-012',
                    'TC-FILE-OPEN-013', 'TC-TAO-HOME-002', 'TC-EXPLORER-013', 'TC-FILE-OPEN-041',
                    'TC-FILE-OPEN-049', 'TC-MODULES-102', 'TC-TAOFFICE-001', 'TC-TAOFFICE-009',
                    'TC-TAOFFICE-034', 'TC-TAOFFICE-040', 'TC-TAOFFICE-042', 'TC-TAOFFICE-045', 'TC-TAOFFICE-046'}
        for entry in native:
            with self.subTest(profile=entry['linux_profile']):
                self.assertEqual(set(entry['selected_ids']), expected)

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
        from qa_ui_auto.ci import discover
        plan = make_plan(args(scope='all', platforms='linux', modes='native',
                              linux_profiles='ubuntu-24.04-xvfb,ubuntu-26.04-wayland'))
        x11 = [e for e in plan['entries'] if e['linux_profile'] == 'ubuntu-24.04-xvfb']
        wayland = [e for e in plan['entries'] if e['linux_profile'] == 'ubuntu-26.04-wayland']
        # linux_x11_required cases are a declared capability gap on Wayland, not
        # a silently dropped id: the Wayland selection must equal the X11 one
        # minus exactly the cases that declare that requirement.
        x11_only = {case.id for case in discover(Path('qa-ui-auto-tests/cases'))
                    if 'linux_x11_required' in case.fixtures}
        self.assertIn('TC-SHOT-N25', x11_only)
        self.assertEqual({cid for entry in x11 for cid in entry['selected_ids']} - x11_only, {
            cid for entry in wayland for cid in entry['selected_ids']
        })
        self.assertEqual(len(x11), 2)
        self.assertEqual(len(wayland), 2)
        self.assertEqual(sum('dual-display' in e['capabilities'] for e in wayland), 1)
        # The dual-display dependency walk must not overwrite the impacted
        # planner's changed-path list with its loop-control boolean. The
        # workflow summary iterates this field after planning.
        self.assertIsInstance(plan['changed_paths'], list)
        # Only the profile-bound X11 requirements are compared here; opt-in
        # credential gaps apply to both profiles and are asserted separately.
        self.assertEqual([(g['case'], g['linux_profile']) for g in plan['gaps']
                          if g['case'] in x11_only],
                         [(cid, 'ubuntu-26.04-wayland') for cid in sorted(x11_only)])

    def test_mfa_scan_retains_authorization_browser_cleanup_predecessor_in_same_shard(self):
        plan = make_plan(args(scope='selected', platforms='linux,windows', modes='native',
                              case_ids='TC-MFA-106', shards='auto',
                              linux_profiles=','.join(LINUX_PROFILES)))
        for entry in plan['entries']:
            if 'TC-MFA-106' in entry['selected_ids']:
                self.assertIn('TC-BACKUP-AUTH-715', entry['selected_ids'])
                self.assertLess(entry['selected_ids'].index('TC-BACKUP-AUTH-715'),
                                entry['selected_ids'].index('TC-MFA-106'))
        self.assertEqual(sum('TC-MFA-106' in e['selected_ids'] for e in plan['entries']), 5)

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

    def test_public_java_project_is_selected_and_provisioned_on_every_native_platform(self):
        cid = 'TC-IDE-C6-06-java-definition-realproject-native'
        for scope in ('selected', 'all'):
            plan = make_plan(args(scope=scope, case_ids=cid if scope == 'selected' else '', modes='native'))
            self.assertFalse(any(gap['case'] == cid for gap in plan['gaps']))
            entries = [entry for entry in plan['entries'] if cid in entry['selected_ids']]
            self.assertEqual({entry['platform_key'] for entry in entries}, {'linux', 'windows', 'macos'})
            for entry in entries:
                self.assertIn('java', entry['capabilities'])
                self.assertIn('java-real-project', entry['capabilities'])
        other = make_plan(args(scope='selected', case_ids='TC-IDE-C6-05-query-definition-reveal-history-native', modes='native'))
        self.assertTrue(all('java-real-project' not in entry['capabilities'] for entry in other['entries']))

    def test_opt_in_fixture_cases_become_declared_gaps_without_a_credential(self):
        plan = make_plan(args(scope='all', platforms='linux', modes='native'))
        gapped = {gap['case'] for gap in plan['gaps']}
        selected = {cid for entry in plan['entries'] for cid in entry['selected_ids']}
        self.assertIn('TC-TAO-HOME-005', gapped)
        self.assertIn('TC-TAO-HOME-047', gapped)
        self.assertFalse(gapped & selected)
        reasons = {gap['reason'] for gap in plan['gaps']}
        self.assertTrue(any('real provider key' in reason for reason in reasons))
        self.assertTrue(any('Agnes key' in reason for reason in reasons))
        # The gap is per platform/mode and every real-provider case is native only.
        self.assertTrue(all(gap['mode'] == 'native' for gap in plan['gaps']))

    def test_opt_in_fixture_is_selected_when_its_credential_is_exported(self):
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith('TAOMNI_QA_') or key.startswith('TAOMNI_QA_TAO_')}
        with patch.dict(os.environ, {**environment, 'TAOMNI_QA_DEEPSEEK_KEY': 'unit-secret'}, clear=True):
            plan = make_plan(args(scope='selected', platforms='linux', modes='native',
                                  case_ids='TC-TAO-HOME-005'))
        self.assertEqual([entry['selected_ids'] for entry in plan['entries']],
                         [['TC-TAO-HOME-005']])
        self.assertFalse(any(gap['case'] == 'TC-TAO-HOME-005' for gap in plan['gaps']))

    def test_agnes_regression_requires_the_agnes_credential(self):
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith('TAOMNI_QA_') or key.startswith('TAOMNI_QA_TAO_')}
        with patch.dict(os.environ, {**environment, 'TAOMNI_QA_DEEPSEEK_KEY': 'unit-secret'}, clear=True):
            plan = make_plan(args(scope='all', platforms='linux', modes='native'))
        reasons = {gap['case']: gap['reason'] for gap in plan['gaps']}
        self.assertIn('Agnes key', reasons['TC-TAO-HOME-047'])
        self.assertNotIn('TC-TAO-HOME-005', reasons)
        with patch.dict(os.environ, {**environment, 'TAOMNI_QA_DEEPSEEK_KEY': 'unit-secret',
                                     'TAOMNI_QA_AGNES_KEY': 'unit-secret'}, clear=True):
            plan = make_plan(args(scope='selected', platforms='linux', modes='native',
                                  case_ids='TC-TAO-HOME-047'))
        self.assertEqual([entry['selected_ids'] for entry in plan['entries']],
                         [['TC-TAO-HOME-047']])

    def test_explicit_opt_in_selection_without_a_credential_fails_planning(self):
        with patch.dict(os.environ, {key: value for key, value in os.environ.items()
                                     if not key.startswith('TAOMNI_QA_')}, clear=True):
            with self.assertRaisesRegex(ValueError, 'unavailable in requested combinations'):
                make_plan(args(scope='selected', platforms='linux', modes='native',
                               case_ids='TC-TAO-HOME-005'))

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

    def test_empty_platform_and_mode_defaults_resolve_to_full_matrix(self):
        plan = make_plan(args(scope="smoke", platforms="", modes=""))
        self.assertEqual(len(plan["entries"]), 6)

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
