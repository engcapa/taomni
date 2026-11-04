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
    def test_real_workers_use_pinned_install_and_native_namespace_without_changing_normal_lanes(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-entry.yml').read_text())
        steps = workflow['jobs']['entry']['steps']
        install = next(s for s in steps if s.get('name') == 'Install all six pinned real orchestration harnesses before network isolation')
        native = next(s for s in steps if s.get('name') == 'Native Taomni six-worker scheduling in loopback-only namespace')
        self.assertLess(steps.index(install), steps.index(native))
        self.assertIn("contains(matrix.capabilities, 'orchestration-workers')", install['if'])
        self.assertIn('install_harnesses.py', install['run'])
        self.assertNotIn('--harness', install['run'])
        for contract in ('ci_network.py', 'ci_native.py', '--uid', '--gid', '--native-artifact', '--installation', '--adapter-bin', '--adapter-sha256', '--run-id', '--attempt'):
            self.assertIn(contract, native['run'])
        self.assertNotIn('validate_workers.py', native['run'])
        for name in ('Run selected cases (Linux Xvfb desktop)', 'Run selected cases (Linux VNC or GNOME Wayland desktop)'):
            normal = next(s for s in steps if s.get('name') == name)
            self.assertIn("!contains(matrix.capabilities, 'orchestration-workers')", normal['if'])
        runtime = next(s for s in steps if s.get('name') == "Download this invocation's verified native runtime")
        self.assertLess(steps.index(runtime), steps.index(native))
        standalone = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-platforms.yml').read_text())['jobs']['orchestration-contracts']
        self.assertEqual(standalone['runs-on'], 'ubuntu-22.04')
        validation = next(s for s in standalone['steps'] if s.get('name') == 'Validate all real workers against loopback-only fixtures')
        self.assertEqual(validation['run'].count('"$(command -v python)"'), 2)
        self.assertNotIn('sysctl', validation['run'])

    def test_frontend_regressions_run_once_on_linux_producer_and_keep_original_log(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-entry.yml').read_text())
        steps = workflow['jobs']['entry']['steps']
        step = next(s for s in steps if s.get('name') == 'Frontend behavior unit regressions')
        self.assertEqual(step['if'], "runner.os == 'Linux' && inputs.operation == 'build'")
        self.assertIn('pnpm check:refactor', step['run'])
        self.assertIn('pnpm exec vitest run 2>&1 | tee qa-build-output/frontend-unit-contracts.log', step['run'])
        # No path filters: the final candidate must retain the complete frontend
        # unit suite, including the newly merged mail/editor lifecycle tests.
        self.assertEqual(step['run'].count('pnpm exec vitest run'), 1)
        upload = next(s for s in steps if s.get('name') == 'Retain native build diagnostics')
        self.assertIn('qa-build-output/frontend-unit-contracts.log', upload['with']['path'])
        prototype = 'docs-feature/development-orchestrator/ui-prototype-v0.6-model.test.mjs'
        self.assertIn(f'node --test {prototype}', step['run'])
        self.assertIn('qa-build-output/orchestration-prototype-unit-contracts.log', upload['with']['path'])
        config = (ROOT / 'vitest.config.ts').read_text()
        self.assertIn(f'"{prototype}"', config)
        self.assertIn('"scripts/*.test.mjs"', config)

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

    @unittest.skipUnless(os.name == 'posix' and shutil.which('bash'), 'POSIX shell contract')
    def test_rust_contracts_use_one_root_binary_with_all_selected_filters(self):
        script = ROOT / '.agents/skills/qa-ui-auto/scripts/ci_rust_contracts.sh'
        combinations = [(rdp, dual, orch) for rdp in (False, True) for dual in (False, True) for orch in (False, True)]
        for rdp, dual, orch in combinations:
            with self.subTest(rdp=rdp, dual=dual, orch=orch), tempfile.TemporaryDirectory() as tmp:
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
                           QA_DUAL_CONTRACTS=str(dual).lower(), QA_ORCH_CONTRACTS=str(orch).lower(), QA_RELEASE='true')
                subprocess.run(['bash', str(script)], cwd=root, env=env, check=True, capture_output=True)
                commands = [json.loads(line)[1:] for line in log.read_text().splitlines()] if log.exists() else []
                if not rdp and not dual and not orch:
                    self.assertFalse(commands)
                    continue
                root_tests = [c for c in commands if '--lib' in c and '-p' not in c and '--ignored' not in c]
                native_lifecycle = [c for c in commands if 'hosted_lifecycle_' in c]
                self.assertEqual(len(native_lifecycle), 1 if orch else 0)
                if orch:
                    self.assertEqual(native_lifecycle[0], ['test', '--locked', '--release', '--lib', 'hosted_lifecycle_', '--', '--ignored', '--nocapture'])
                self.assertEqual(len(root_tests), 1)
                expected = ['lsp::tests::workspace_watch_lifetime', 'commands::workspace_reads::tests',
                    'workspace::tests::text_and_encoding', 'workspace::tests::encoding_matrix'] + (['rdp::'] if rdp else []) + (['capture::', 'screenshot::', 'mfa::'] if dual else []) + (['orchestration::', 'llm::invocation', 'go_compatibility_tests'] if orch else [])
                self.assertEqual(root_tests[0], ['test', '--locked', '--release', '--lib', '--', *expected])
                self.assertEqual(any('rdp-probe' in c for c in commands), rdp)
                self.assertEqual(any('profile_photo_encoder_costs' in c for c in commands), rdp)
