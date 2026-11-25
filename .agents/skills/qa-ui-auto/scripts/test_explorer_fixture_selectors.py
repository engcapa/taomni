"""Path selectors must track native separator spelling without basename fallback."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase

from qa_ui_auto.config import resolve
from qa_ui_auto.fixtures.explorer_files import path_attribute_match, setup


class ExplorerFixtureSelectorTest(TestCase):
    def test_css_matches_windows_boundary_spellings_and_no_unrelated_path(self):
        path = 'D:/a/qa report/source/folder'
        selector = '[data-testid="explorer-nav-node"]' + path_attribute_match(path)
        expected = [
            path,
            r'D:\a\qa report\source\folder',
            r'D:/a\qa report\source\folder',
            r'D:/a/qa report\source\folder',
            r'D:/a/qa report/source\folder',
        ]
        self.assertEqual(
            selector,
            '[data-testid="explorer-nav-node"]:is('
            + ','.join('[data-path=' + json.dumps(value) + ']' for value in expected)
            + ')',
        )

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
