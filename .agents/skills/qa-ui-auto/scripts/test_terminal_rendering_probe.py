"""Pixel-oracle and failure-preservation contracts; no browser/native launch."""
import json
from pathlib import Path
import tempfile
from unittest import TestCase
from unittest.mock import patch

from PIL import Image, ImageDraw
from qa_ui_auto import terminal_rendering_probe as probe
from qa_ui_auto.steps import StepError


class PixelOracleTest(TestCase):
    def test_real_pixel_changes_fail_even_when_size_and_text_contracts_match(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            reference, actual = folder / 'before.png', folder / 'after.png'
            image = Image.new('RGB', (120, 60), 'black')
            ImageDraw.Draw(image).rectangle((10, 10, 80, 19), fill='white')
            image.save(reference)
            image.save(actual)
            args = ([{'x': 10, 'y': 10, 'width': 80, 'height': 12}],
                    {'width': 120, 'height': 60}, folder)
            self.assertTrue(probe.compare_pixels(reference, actual, *args, 'same')[0]['passed'])
            Image.new('RGB', (120, 60), 'black').save(actual)
            result = probe.compare_pixels(reference, actual, *args, 'missing-glyphs')
            self.assertFalse(result[0]['passed'])
            self.assertEqual(result[0]['maxBlockChannelDifference'], 255)
            self.assertTrue((folder / 'missing-glyphs-0-difference.png').is_file())

    def test_viewport_resize_cannot_hide_a_rendering_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            before, after = folder / 'before.png', folder / 'after.png'
            Image.new('RGB', (120, 60)).save(before)
            Image.new('RGB', (121, 60)).save(after)
            with self.assertRaisesRegex(StepError, 'viewport changed'):
                probe.compare_pixels(before, after, [], {'width': 120, 'height': 60}, folder, 'resize')


class ProbeLifecycleTest(TestCase):
    def test_failure_still_restores_fixture_and_retains_original_observations(self):
        calls = []
        observed = {'pending': 0, 'headers': [probe.HEADER, probe.HEADER],
                    'cells': [], 'sessions': ['a', 'b', 'c'],
                    'shared': True, 'sameTerms': True, 'removals': 4}

        def evaluate(expression):
            calls.append(expression)
            return {'width': 120, 'height': 60} if 'width: innerWidth' in expression else observed

        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            with patch.object(probe, 'compare_pixels', return_value=[{'passed': False}]):
                with self.assertRaisesRegex(StepError, 'glyph pixels'):
                    probe.run_probe(folder, evaluate, lambda path: None, None)
            result = json.loads((folder / 'terminal-rendering.json').read_text())
            self.assertFalse(result['passed'])
            self.assertEqual([stage['scenario'] for stage in result['stages']], ['clear', 'merge'])
            self.assertEqual(result['stages'][0]['observation']['headers'], observed['headers'])
            self.assertTrue(calls[-1].endswith('("cleanup",0)'))
