import unittest
import xml.etree.ElementTree as ET
from qa_ui_auto.markdown_testing_quality import inspect_word_strokes
from qa_ui_auto.steps import StepError


class WordLineBodyTest(unittest.TestCase):
    def path(self, pattern, stroke='#475569', width='1px'):
        return ET.fromstring(f'<svg><path class="flowchart-link" stroke="{stroke}" stroke-width="{width}" stroke-dasharray="{pattern}" marker-end="url(#arrow)"/></svg>')

    def test_reported_zero_gap_patterns_are_rejected_even_with_arrow(self):
        for pattern in ('0px', '0px, 0px', '1px, 0px'):
            with self.subTest(pattern=pattern), self.assertRaises(StepError):
                inspect_word_strokes(self.path(pattern))

    def test_solid_and_real_dashed_line_bodies_are_visible(self):
        for pattern in ('none', '4 2'):
            self.assertEqual(inspect_word_strokes(self.path(pattern)), 1)

    def test_arrow_only_or_zero_width_does_not_pass(self):
        for stroke, width in [('none', '1px'), ('#475569', '0px')]:
            with self.assertRaises(StepError):
                inspect_word_strokes(self.path('none', stroke, width))


if __name__ == '__main__':
    unittest.main()
