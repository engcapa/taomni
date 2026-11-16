"""Independent DOM-oracle checks for actual provider Markdown evidence."""
import json
from pathlib import Path
import subprocess
import unittest

import yaml

from qa_ui_auto.steps import StepError
from qa_ui_auto.tao_real_documents import DOCUMENT, assert_document, history_selector
from qa_ui_auto.testcase import validate_doc


class DocumentTests(unittest.TestCase):
    def test_each_semantic_part_is_required_and_truthy_values_are_insufficient(self):
        assert_document(dict(heading=True, table=True, code=True))
        for values in ({}, dict(heading=True, table=True, code=False),
                       dict(heading=1, table=True, code=True)):
            with self.subTest(values=values), self.assertRaises(StepError):
                assert_document(values)

    def test_document_oracle_checks_real_dom_structure_inside_assistant_bodies(self):
        good = '<h2>QA Markdown</h2><table><tr><th>Expression</th><th>Result</th></tr><tr><td>2 + 3</td><td>5</td></tr></table><pre><code>print("TQfixture")</code></pre>'
        for body, expected in (
            (good, dict(heading=True, table=True, code=True)),
            (good.replace('<pre><code>', '<p>').replace('</code></pre>', '</p>'), dict(heading=True, table=True, code=False)),
            (good.replace('<td>5</td>', '<td>6</td>'), dict(heading=True, table=False, code=True)),
        ):
            with self.subTest(expected=expected):
                html = '<section data-testid="tao-ai-chat" data-tao-active="true"><article data-testid="tao-home-message-user">' + good + '</article><div data-testid="tao-home-markdown-reply">' + body + '</div></section>'
                script = "const {JSDOM}=require('jsdom'); const document=new JSDOM(process.argv[1]).window.document; process.stdout.write(JSON.stringify(new Function('document',process.argv[2])(document)));"
                result = subprocess.run(["node", "-e", script, html, DOCUMENT.replace("MARKER", json.dumps("TQfixture"))], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), expected)

    def test_user_markup_alone_cannot_pass_as_a_provider_document(self):
        script = "const {JSDOM}=require('jsdom');const document=new JSDOM('<section data-testid=tao-ai-chat data-tao-active=true><h2>QA Markdown</h2><pre><code>print(\\\"TQfixture\\\")</code></pre></section>').window.document;process.stdout.write(JSON.stringify(new Function('document',process.argv[1])(document)));"
        result = subprocess.run(["node", "-e", script, DOCUMENT.replace("MARKER", json.dumps("TQfixture"))], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), dict(heading=False, table=False, code=False))

    def test_registered_case_has_a_valid_reviewed_contract(self):
        path = Path(__file__).resolve().parents[4] / "qa-ui-auto-tests/cases/TC-TAO-HOME-013-native-real-deepseek-documents.testcase.yaml"
        self.assertEqual(validate_doc(yaml.safe_load(path.read_text(encoding="utf-8")), source=str(path)), [])

    def test_branch_history_selector_matches_a_real_unicode_title(self):
        title = 'QA synthetic title · Branch'
        html = '<button class="tao-home-history-row" data-title="' + title + '"></button>'
        script = "const {JSDOM}=require('jsdom');const document=new JSDOM(process.argv[1]).window.document;process.stdout.write(String(!!document.querySelector(process.argv[2])));"
        result = subprocess.run(["node", "-e", script, html, history_selector(title)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "true")


if __name__ == "__main__":
    unittest.main()
