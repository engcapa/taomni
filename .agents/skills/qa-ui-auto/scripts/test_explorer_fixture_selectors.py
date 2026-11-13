"""Path selectors must track native separator spelling without basename fallback."""
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase

from qa_ui_auto.config import resolve
from qa_ui_auto.fixtures.explorer_files import path_attribute_match, setup


class ExplorerFixtureSelectorTest(TestCase):
    def test_css_matches_both_exact_windows_spellings_and_no_unrelated_path(self):
        path = 'D:/a/qa report/source/folder'
        selector = '[data-testid="explorer-nav-node"]' + path_attribute_match(path)
        program = r"""
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {selector, path} = JSON.parse(process.argv[1]);
const doc = new JSDOM('<main></main>').window.document;
const add = value => {
  const el = doc.createElement('div');
  el.dataset.testid = 'explorer-nav-node'; el.dataset.path = value;
  doc.querySelector('main').append(el); return el;
};
const slash = add(path), native = add(path.replaceAll('/', '\\'));
add('D:/unrelated/folder'); add(path + '/child'); add('E:' + path.slice(2));
assert.deepEqual([...doc.querySelectorAll(selector)], [slash, native]);
"""
        subprocess.run(["node", "-e", program, json.dumps({"selector": selector, "path": path})],
                       check=True, capture_output=True, text=True)

    def test_posix_quotes_backslashes_and_spaces_are_escaped_as_literal_attributes(self):
        path = '/qa/report "quoted"/folder\\name'
        selector = path_attribute_match(path)
        self.assertEqual(selector, ':is([data-path=' + json.dumps(path) + '])')

    def test_native_setup_publishes_full_path_matchers_without_changing_files(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "case").mkdir()
            ctx = SimpleNamespace(cfg={"app": {"mode": "native"}}, values={},
                                  report_root=root, case_dir=root / "case", case_id="selectors")
            setup(ctx)
            values = ctx.values
            self.assertEqual(values['explorer_crumb_folder_match'],
                             path_attribute_match(values['explorer_target'] + '/folder'))
            self.assertEqual(values['explorer_source_folder_match'],
                             path_attribute_match(values['explorer_source'] + '/folder'))
            self.assertTrue((Path(values['explorer_target']) / 'folder/drag-source.txt').is_file())
            template = '[data-testid="explorer-crumb"]${fixture.explorer_crumb_folder_match}'
            expanded = resolve(template, cfg={}, fixture=values)
            self.assertEqual(expanded, '[data-testid="explorer-crumb"]' + values['explorer_crumb_folder_match'])
