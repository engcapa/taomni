import unittest
import xml.etree.ElementTree as ET
from qa_ui_auto.markdown_testing_quality import inspect_word_strokes, inspect_word_text_layout
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


class WordCjkPositionTest(unittest.TestCase):
    def test_default_font_metrics_do_not_establish_unclipped_cjk(self):
        for text in ('<text>评估目标</text>', '<text><tspan x="0" y="10">评估目标</tspan></text>'):
            with self.subTest(text=text), self.assertRaises(StepError):
                inspect_word_text_layout(ET.fromstring('<svg>' + text + '</svg>'))

    def test_measured_glyph_positions_keep_a_complete_label(self):
        svg = ET.fromstring('<svg><text><tspan x="-16" y="10" text-anchor="start">评</tspan><tspan x="0" y="10" text-anchor="start">估</tspan><tspan x="16" y="10" text-anchor="start"> (Evaluate)</tspan></text></svg>')
        self.assertEqual(inspect_word_text_layout(svg), 2)
        self.assertEqual(''.join(svg.itertext()), '评估 (Evaluate)')

    def test_invalid_glyph_coordinates_are_rejected(self):
        for value in ('', 'NaN', 'inf', '0 16'):
            with self.subTest(value=value), self.assertRaises(StepError):
                inspect_word_text_layout(ET.fromstring(f'<svg><text><tspan x="{value}" y="10" text-anchor="start">评</tspan></text></svg>'))


if __name__ == '__main__':
    unittest.main()
