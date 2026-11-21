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
    def test_windows_native_cache_restore_never_crosses_runner_images(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-entry.yml').read_text())
        steps = workflow['jobs']['entry']['steps']
        scope = next(s for s in steps if s.get('id') == 'windows-cache-scope')
        self.assertIn("runner.os == 'Windows'", scope['if'])
        script = scope['run'].split('\n', 1)[1].rsplit('\nPY', 1)[0]
        for image, expected_scope in [('20261116.315.1', 'image-20261116.315.1'),
                                      ('20261109.311.1', 'image-20261109.311.1'), ('', 'run-17-2')]:
            with self.subTest(image=image), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / 'output'
                env = dict(os.environ, ImageVersion=image, GITHUB_OUTPUT=str(output),
                           QA_CACHE_PLATFORM='windows', GITHUB_RUN_ID='17', GITHUB_RUN_ATTEMPT='2')
                subprocess.run([sys.executable, '-c', script], env=env, check=True)
                self.assertEqual(output.read_text(), f'platform=windows-{expected_scope}\n')
        expected_key = '${{ steps.windows-cache-scope.outputs.platform || matrix.cache_key }}'
        dependencies = next(s for s in steps if s.get('uses') == 'swatinem/rust-cache@v2')
        self.assertIn(expected_key, dependencies['with']['shared-key'])
        for name in ('Native QA workspace cache', 'Native Rust contracts cache'):
            paths = next(s['with'] for s in steps if s.get('name') == name)
            for key in [paths['key'], *paths['restore-keys'].splitlines()]:
                self.assertIn(expected_key, key)

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

    def test_each_platform_waits_for_its_producer_and_optional_signed_input_without_other_core_builds(self):
        jobs = yaml.safe_load((ROOT / '.github/workflows/qa-ui-auto-platforms.yml').read_text())['jobs']
        for platform in ('linux', 'windows', 'macos'):
            dependencies = ['plan', f'build-{platform}', 'signed-modular-packages']
            modules = ['mfa', 'vnc', 'rdp'] if platform in ('linux', 'macos') else ['vnc', 'rdp']
            for module in modules:
                signer = f'signed-{module}-{platform}'
                dependencies.append(signer)
                self.assertIn(signer, jobs['summarize']['needs'])
                self.assertIn(f"contains(needs.plan.outputs.{platform}_native_matrix, 'signed-{module}')", jobs[signer]['if'])
                self.assertEqual(jobs[signer]['with']['module'],
                                 f'{module}-client' if module in ('rdp', 'vnc') else module)
                self.assertEqual(jobs[signer]['with']['native_builds'],
                                 '${{ needs.plan.outputs.' + platform + '_build_matrix }}')
            self.assertEqual(jobs[f'execute-{platform}-native']['needs'], dependencies)
            self.assertIn(f'execute-{platform}-native', jobs['summarize']['needs'])
            self.assertIn(f'build-{platform}', jobs['summarize']['needs'])
        self.assertEqual(jobs['native-contracts']['needs'], 'plan')
        self.assertIn('native-contracts', jobs['summarize']['needs'])
        self.assertIn('tool-contracts', jobs['summarize']['needs'])
        self.assertIn('signed-modular-packages', jobs['summarize']['needs'])
        self.assertIn("contains(needs.plan.outputs.native_matrix, 'signed-module')", jobs['signed-modular-packages']['if'])
        self.assertNotIn('Validate QA tools', [s.get('name') for s in jobs['plan']['steps']])

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
                    'workspace::tests::text_and_encoding', 'workspace::tests::encoding_matrix',
                    'plugin::migration::', 'deepseek_app::'] + (['rdp::'] if rdp else []) + (['capture::', 'screenshot::', 'mfa::'] if dual else [])
                self.assertEqual(root_tests[0], ['test', '--locked', '--release', '--lib', '--', *expected])
                self.assertEqual(any('rdp-probe' in c for c in commands), rdp)
                self.assertEqual(any('profile_photo_encoder_costs' in c for c in commands), rdp)
