import json
from pathlib import Path
import tempfile
import unittest

from qa_ui_auto.ci import aggregate, selection_digest, write_json
from qa_ui_auto.runner_receipt import emit_runner_receipt


class ReportTests(unittest.TestCase):
    def example(self, root, status='passed'):
        entry={'id':'linux-browser','mode':'browser','platform':'Linux','selected_ids':['TC-X'], 'case_digests':{'TC-X':'case-hash'}}
        manifest={'head':'commit','entries':[entry],'identity':{'source_sha256':'source','runner_sha256':'runner'},'gaps':[],'unreviewed':[]}
        run=root/'linux-browser'/'run-1'; run.mkdir(parents=True)
        summary={'exit_code':0 if status=='passed' else 1,'mode':'browser','platform':'Linux',
          'dry_run':False,'identity_stable':True,'identity':manifest['identity'],
          'selection':{'selected':['TC-X']},'cases':[{'id':'TC-X','status':status,'case_sha256':'case-hash'}]}
        summary['totals'] = {'total': 1, **{k: int(status == k) for k in ('passed', 'failed', 'skipped')}}
        write_json(run/'summary.json',summary)
        emit_runner_receipt(report_root=run,mode='browser',executed_cmd=['qa-test'],
          started_at='2026-09-20T00:00:00+00:00',finished_at='2026-09-20T00:00:01+00:00',duration_sec=1,exit_code=summary['exit_code'])
        write_json(root/'linux-browser'/'ci-outcome.json',{'head':'commit','entry':'linux-browser','exit_code':summary['exit_code'],
                                                        'selection_sha256':selection_digest(manifest)})
        return manifest,run

    def test_valid_receipt_and_exact_scope_pass(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); manifest,_=self.example(root)
            self.assertTrue(aggregate(manifest,root)['passed'])

    def test_skip_never_becomes_pass(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); manifest,_=self.example(root,'skipped')
            self.assertFalse(aggregate(manifest,root)['passed'])

    def test_tampered_summary_and_missing_combination_fail(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); manifest,run=self.example(root)
            (run/'summary.json').write_text((run/'summary.json').read_text()+' ')
            self.assertFalse(aggregate(manifest,root)['passed'])
            (run/'summary.json').unlink()
            self.assertFalse(aggregate(manifest,root)['passed'])

    def test_other_invocation_outcome_cannot_certify_selected_run(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); manifest,_=self.example(root)
            path=root/'linux-browser'/'ci-outcome.json'
            outcome=json.loads(path.read_text()); outcome['run_id']='another-run'
            write_json(path,outcome)
            result=aggregate(manifest,root)
            self.assertFalse(result['passed'])
            self.assertIn('execution selection/run identity differs',result['entries'][0]['errors'])
