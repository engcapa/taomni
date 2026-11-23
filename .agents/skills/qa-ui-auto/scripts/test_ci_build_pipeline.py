"""Contracts for independent build consumers and the retained Rust test union."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[4]


class BuildPipelineTests(unittest.TestCase):
    def test_frontend_regressions_run_in_parallel_sharded_job_and_keep_original_log(self):
        entry = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-entry.yml').read_text())
        entry_steps = entry['jobs']['entry']['steps']
        self.assertIsNone(
            next((s for s in entry_steps if s.get('name') == 'Frontend behavior unit regressions'), None)
        )
        platforms = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-platforms.yml').read_text())
        job = platforms['jobs']['frontend-contracts']
        self.assertEqual(job['needs'], 'plan')
        self.assertEqual(job['strategy']['matrix']['shard'], [1, 2, 3, 4])
        self.assertIn("github.event_name == 'pull_request'", job['if'])
        self.assertIn("github.event_name == 'schedule'", job['if'])
        steps = job['steps']
        refactor_step = next(s for s in steps if s.get('name') == 'Frontend refactor and QA script unit contracts')
        self.assertEqual(refactor_step['if'], 'matrix.shard == 1')
        self.assertIn('pnpm exec tsc -b', refactor_step['run'])
        self.assertIn('pnpm check:refactor', refactor_step['run'])
        self.assertEqual(platforms['jobs']['execute-macos-native']['with']['max_parallel'], 4)
        vitest_step = next(s for s in steps if s.get('name') == 'Frontend Vitest unit regressions')
        self.assertIn('pnpm exec vitest run --shard=${{ matrix.shard }}/4', vitest_step['run'])
        # No path filters: the final candidate must retain the complete frontend
        # unit suite across shards, including the newly merged mail/editor lifecycle tests.
        self.assertEqual(vitest_step['run'].count('pnpm exec vitest run'), 1)
        upload = next(s for s in steps if s.get('name') == 'Retain frontend contract logs')
        self.assertIn('qa-build-output/frontend-unit-contracts.log', upload['with']['path'])
        self.assertIn('frontend-contracts', platforms['jobs']['summarize']['needs'])
        for platform in ('linux', 'windows', 'macos'):
            self.assertNotIn('frontend-contracts', platforms['jobs'][f'execute-{platform}-native']['needs'])

    def test_focused_native_runs_still_check_frontend_build_inputs(self):
        jobs = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-platforms.yml').read_text())['jobs']
        checks = jobs['selected-build-checks']
        self.assertEqual(checks['needs'], 'plan')
        self.assertIn("inputs.scope == 'selected'", checks['if'])
        self.assertIn("needs.plan.outputs.has_native == 'true'", checks['if'])
        self.assertIn("github.event_name != 'pull_request'", checks['if'])
        self.assertIn("github.event_name != 'schedule'", checks['if'])
        self.assertEqual(checks['steps'][0]['with']['ref'], '${{ needs.plan.outputs.head }}')
        self.assertIn('pnpm exec tsc -b && pnpm check:refactor',
                      [step.get('run') for step in checks['steps']])
        self.assertIn('selected-build-checks', jobs['summarize']['needs'])

    def test_failed_contracts_cannot_leave_a_passing_aggregate(self):
        jobs = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-platforms.yml').read_text())['jobs']
        step = next(s for s in jobs['summarize']['steps'] if s.get('name') == 'Include supporting job results')
        script = step['run'].split("python - <<'PYTHON'\n", 1)[1].rsplit('PYTHON', 1)[0]
        for status, expected in [('success', True), ('failure', False), ('cancelled', False), ('skipped', True)]:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); report = root / 'qa-ui-auto-report'; report.mkdir()
                summary = report / 'ci-summary.json'
                summary.write_text(json.dumps({'passed': True, 'report_ok': True, 'infrastructure_errors': [], 'failures': []}))
                env = dict(os.environ, QA_JOB_RESULTS=json.dumps({'native-contracts': {'result': status}}),
                           GITHUB_STEP_SUMMARY=str(root / 'step-summary.md'))
                result = subprocess.run([sys.executable, '-c', script], cwd=root, env=env, capture_output=True)
                self.assertEqual(result.returncode, 0 if expected else 1, result.stderr)
                data = json.loads(summary.read_text())
                self.assertEqual(data['passed'], expected)
                self.assertEqual(data['report_ok'], expected)
                self.assertEqual(data['job_results']['native-contracts'], status)
                if not expected:
                    self.assertEqual(data['failures'][0]['case'], 'infrastructure')
                    self.assertEqual(data['infrastructure_errors'][0]['entry'], 'native-contracts')

    def test_each_platform_waits_only_for_its_producer_and_final_gate_keeps_contracts(self):
        jobs = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-platforms.yml').read_text())['jobs']
        for platform in ('linux', 'windows', 'macos'):
            self.assertEqual(jobs[f'execute-{platform}-native']['needs'], ['plan', f'build-{platform}'])
            self.assertIn(f'execute-{platform}-native', jobs['summarize']['needs'])
            self.assertIn(f'build-{platform}', jobs['summarize']['needs'])
        self.assertEqual(jobs['native-contracts']['needs'], 'plan')
        self.assertIn('native-contracts', jobs['summarize']['needs'])
        self.assertIn('tool-contracts', jobs['summarize']['needs'])
        self.assertNotIn('Validate QA tools', [s.get('name') for s in jobs['plan']['steps']])

    def test_rust_cache_prunes_targets_reusable_runtime_cache_replaces_raw_target_and_windows_contracts_decouple(self):
        entry = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-entry.yml').read_text())
        steps = entry['jobs']['entry']['steps']
        names = [s.get('name') for s in steps]
        self.assertNotIn('Native QA workspace cache', names)
        self.assertNotIn('Native Rust contracts cache', names)
        reusable = next(s for s in steps if s.get('name') == 'Native QA reusable runtime cache')
        self.assertEqual(reusable['id'], 'reusable-runtime-cache')
        rust_cache = next(s for s in steps if str(s.get('uses', '')).startswith('swatinem/rust-cache@'))
        self.assertTrue(rust_cache['with']['cache-targets'])
        self.assertFalse(rust_cache['with'].get('cache-on-failure', False))
        self.assertIn('steps.reusable-runtime.outputs.available', rust_cache['if'])
        self.assertIn("steps.branch-cargo-restore.outcome != 'success'", rust_cache['if'])
        self.assertIn('-sockscap', rust_cache['with']['shared-key'])
        self.assertIn("!(runner.os == 'Linux' && inputs.operation == 'contracts')", str(rust_cache['with']['save-if']))
        self.assertNotIn('lookup-only', rust_cache['with'])
        self.assertIn("steps.branch-cargo-restore.outcome != 'success'", rust_cache['with']['save-if'])
        self.assertNotIn('steps.branch-cargo-key.outputs.name', rust_cache['with']['save-if'])
        self.assertNotIn('Configure Windows fast linker (lld-link)', names)
        self.assertIn('Configure Linux fast linker (lld)', names)
        build_step = next(s for s in steps if s.get('name') == 'Build and export the verified native runtime')
        self.assertIn('--reusable-archive qa-build-output/reusable-runtime/reusable.tar.gz', build_step['run'])
        for contract_name in (
            'Windows native session cleanup contracts',
            'Windows atomic file replacement contracts',
            'Windows backup journal reader contracts',
            'Windows file observation contracts',
            'Windows capture helper contracts',
        ):
            step = next(s for s in steps if s.get('name') == contract_name)
            self.assertIn("inputs.operation == 'contracts'", step['if'])
            self.assertNotIn("inputs.operation == 'build'", step['if'])
        rust_contracts = next(s for s in steps if s.get('name') == 'Native Rust contracts')
        self.assertIn("runner.os == 'Linux'", rust_contracts['if'])
        sherpa_cache = next(s for s in steps if s.get('name') == 'Sherpa-ONNX prebuilt cache')
        self.assertEqual(sherpa_cache['with']['path'], 'src-tauri/target/qa-ui-auto/sherpa-onnx-prebuilt')
        sherpa_refresh = next(s for s in steps if s.get('name') == 'Ensure Sherpa-ONNX build state and runtime DLLs')
        self.assertIn('scripts/refresh-sherpa-onnx-cache.mjs', sherpa_refresh['run'])
        self.assertIn('cargo clean --manifest-path src-tauri/Cargo.toml --package sherpa-onnx-sys', sherpa_refresh['run'])
        helper_contracts = next(s for s in steps if s.get('name') == 'Windows capture helper contracts')
        self.assertIn("'-p', 'sockscap-helper'", helper_contracts['run'])
        self.assertNotIn('pnpm build:mobile', helper_contracts['run'])

    @unittest.skipUnless(os.name == 'posix' and shutil.which('bash'), 'POSIX shell contract')
    def test_rust_contracts_use_one_root_binary_with_all_selected_filters(self):
        script = ROOT / '.agents/skills/qa-ui-auto/scripts/ci_rust_contracts.sh'
        for rdp, dual in [(True, True), (True, False), (False, True), (False, False)]:
            with self.subTest(rdp=rdp, dual=dual), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); (root / 'src-tauri').mkdir()
                log = root / 'commands.jsonl'
                for name in ('cargo', 'pnpm'):
                    tool = root / name
                    tool.write_text('#!/usr/bin/env python3\nimport json, os, sys\n'
                                    'with open(os.environ["COMMAND_LOG"], "a") as f:\n'
                                    ' f.write(json.dumps(sys.argv) + "\\n")\n')
                    tool.chmod(0o755)
                env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                           COMMAND_LOG=str(log), QA_RDP_CONTRACTS=str(rdp).lower(),
                           QA_DUAL_CONTRACTS=str(dual).lower(), QA_RELEASE='true')
                subprocess.run(['bash', str(script)], cwd=root, env=env, check=True, capture_output=True)
                commands = [json.loads(line)[1:] for line in log.read_text().splitlines()] if log.exists() else []
                if not rdp and not dual:
                    self.assertFalse(commands)
                    continue
                root_tests = [c for c in commands if '--lib' in c and '-p' not in c]
                self.assertEqual(len(root_tests), 1)
                expected = ['lsp::tests::workspace_watch_lifetime', 'commands::workspace_reads::tests',
                    'workspace::tests::text_and_encoding', 'workspace::tests::encoding_matrix'] + (['rdp::'] if rdp else []) + (['capture::', 'screenshot::', 'mfa::'] if dual else [])
                self.assertEqual(root_tests[0], ['test', '--locked', '--release', '--lib', '--', *expected])
                self.assertEqual(any('rdp-probe' in c for c in commands), rdp)
                self.assertEqual(any('profile_photo_encoder_costs' in c for c in commands), rdp)
        script_text = script.read_text(encoding='utf-8')
        self.assertNotIn('CARGO_PROFILE_RELEASE_INCREMENTAL=true', script_text)
        self.assertNotIn('CARGO_PROFILE_RELEASE_CODEGEN_UNITS', script_text)

    def test_release_build_qa_keeps_default_codegen_units_in_build_inputs(self):
        from unittest.mock import patch
        import native_build
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            binary = root / 'src-tauri/target/qa-ui-auto/release' / ('taomni.exe' if os.name == 'nt' else 'taomni')
            def fake_run(cmd, cwd, env, check):
                self.assertIsNone(env.get('CARGO_PROFILE_RELEASE_CODEGEN_UNITS'))
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_bytes(b'release-qa-binary')
            clean_env = {k: v for k, v in os.environ.items() if k != 'CARGO_PROFILE_RELEASE_CODEGEN_UNITS'}
            with patch.dict(os.environ, clean_env, clear=True), \
                 patch.object(native_build, 'ROOT', root), \
                 patch.object(native_build.shutil, 'which', return_value='pnpm'), \
                 patch.object(native_build, 'ensure_linux_link_deps'), \
                 patch.object(native_build, 'source_identity', return_value='src-sha'), \
                 patch.object(native_build, 'recipe_identity', return_value='rec-sha'), \
                 patch.object(native_build.subprocess, 'check_output', return_value='1.0.0\n'), \
                 patch.object(native_build.subprocess, 'run', side_effect=fake_run):
                built = native_build.build_qa(release=True, force=True)
                self.assertEqual(built, binary)
                check = native_build.check_build(release=True)
                self.assertTrue(check['reusable'], check)


class NightlyAndCachePipelineTests(unittest.TestCase):
    def setUp(self):
        self.platforms = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-platforms.yml').read_text())
        self.entry = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-entry.yml').read_text())

    def step(self, workflow, name):
        return next(step for step in workflow['jobs']['entry']['steps'] if step.get('name') == name)

    def test_schedule_policy_and_capacity_gate_are_wired(self):
        plan_job = self.platforms['jobs']['plan']
        gate = next(step for step in plan_job['steps']
                    if step.get('name') == 'Wait for earlier QA platform runs')
        self.assertIn("github.event_name == 'schedule'", gate['if'])
        self.assertIn('qa_capacity_gate.py', gate['run'])
        names = [step.get('name') for step in plan_job['steps']]
        self.assertLess(names.index('Allocate invocation identity'), names.index('Wait for earlier QA platform runs'))
        self.assertTrue(any(str(step.get('uses', '')).startswith('actions/checkout@')
                            for step in plan_job['steps'][:names.index('Wait for earlier QA platform runs')]))
        self.assertEqual(gate['env']['QA_GATE_MAX_WAIT_SECONDS'], '1200')
        plan = next(step for step in plan_job['steps'] if step.get('id') == 'plan')
        self.assertIn("github.event_name == 'schedule'", plan['env']['QA_NIGHTLY_POLICY'])
        self.assertIn('inputs.nightly_policy', plan['env']['QA_NIGHTLY_POLICY'])
        self.assertEqual(plan['env']['QA_NIGHT_LABEL'], '${{ inputs.night_label }}')
        outputs = plan_job['outputs']
        self.assertEqual(outputs['macos_browser_matrix'], '${{ steps.plan.outputs.macos_browser_matrix }}')
        self.assertEqual(outputs['has_macos_browser'], '${{ steps.plan.outputs.has_macos_browser }}')

    def test_macos_browser_shards_are_scheduled_separately_with_a_smaller_cap(self):
        jobs = self.platforms['jobs']
        browser = jobs['execute-browser']['with']
        self.assertEqual(browser['matrix'], '${{ needs.plan.outputs.browser_matrix }}')
        macos = jobs['execute-macos-browser']
        self.assertEqual(macos['with']['max_parallel'], 3)
        self.assertEqual(macos['with']['matrix'], '${{ needs.plan.outputs.macos_browser_matrix }}')
        self.assertEqual(macos['if'], "needs.plan.outputs.has_macos_browser == 'true'")
        self.assertIn('execute-macos-browser', jobs['summarize']['needs'])

    def test_trusted_default_branch_cargo_lookup_precedes_a_cold_build(self):
        steps = self.entry['jobs']['entry']['steps']
        key = self.step(self.entry, 'Cargo dependency archive key')
        self.assertNotIn('QA_BRANCH_ARTIFACTS', key['if'])
        branch = self.step(self.entry, 'Find retained Cargo dependencies on the dispatch branch')
        self.assertIn("env.QA_BRANCH_ARTIFACTS == 'true'", branch['if'])
        trusted = self.step(self.entry, 'Find trusted Cargo dependencies on the default branch')
        self.assertEqual(trusted['with']['trusted'], 'true')
        self.assertEqual(trusted['with']['default-branch'], '${{ env.QA_DEFAULT_BRANCH }}')
        self.assertIn("steps.branch-cargo.outputs.run-id == ''", trusted['if'])
        self.assertIn("env.QA_TRUSTED_CACHE == 'true'", trusted['if'])
        self.assertIn("inputs.trusted_cache != 'false'", self.entry['jobs']['entry']['env']['QA_TRUSTED_CACHE'])
        self.assertIn('trusted_cache:', (ROOT / '.github/workflows/qa-ui-auto-platforms.yml').read_text())
        download = self.step(self.entry, 'Retrieve the trusted Cargo dependencies')
        self.assertEqual(download['with']['run-id'], '${{ steps.trusted-cargo.outputs.run-id }}')
        restore = self.step(self.entry, 'Restore Cargo dependencies')
        self.assertIn('steps.branch-cargo-download.outcome', restore['if'])
        self.assertIn('steps.trusted-cargo-download.outcome', restore['if'])
        pack = self.step(self.entry, 'Package Cargo dependencies')
        self.assertIn("steps.trusted-cargo.outputs.run-id == ''", pack['if'])
        upload = next(step for step in steps if step.get('name') == 'Retain Cargo dependencies')
        self.assertEqual(upload['with']['retention-days'], 3)
        entry_env = self.entry['jobs']['entry']['env']
        self.assertEqual(entry_env['QA_DEFAULT_BRANCH'], '${{ github.event.repository.default_branch }}')

    def test_vendor_cache_experiment_is_callable_and_off_by_default(self):
        env = self.entry['jobs']['entry']['env']
        self.assertIn('inputs.vendor_cache', env['QA_VENDOR_CACHE'])
        normalize = self.step(self.entry, 'Normalize vendored Cargo source mtimes')
        self.assertIn("env.QA_VENDOR_CACHE == '1'", normalize['if'])
        self.assertIn('ci_cargo_artifact.py normalize', normalize['run'])
        calls = {name: self.platforms['jobs'][name]['with'] for name in
                 ('build-linux', 'build-windows', 'build-macos', 'native-contracts')}
        for name, call in calls.items():
            self.assertIn('inputs.vendor_cache', call['vendor_cache'], name)
