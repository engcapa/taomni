from unittest import TestCase

from qa_ui_auto.evidence import text_tail


class TextTailTest(TestCase):
    def test_missing_text_is_explicitly_empty(self):
        for value in (None, "", "   ", "\r\n\n\r"):
            with self.subTest(value=value):
                self.assertEqual(text_tail(value), "<empty>")

    def test_only_the_most_recent_non_empty_rows_survive(self):
        rows = "\n".join(f"line-{index}" for index in range(40))
        tail = text_tail(rows)
        self.assertIn("line-39", tail)
        self.assertNotIn("line-0", tail)

    def test_carriage_returns_do_not_hide_a_matched_line(self):
        self.assertIn("qa-ready", text_tail("noise\r\nqa-ready\r\nqa$"))

    def test_a_very_long_tail_is_truncated_from_the_front(self):
        tail = text_tail("x" * 5000)
        self.assertTrue(tail.startswith("'..."))
        self.assertLessEqual(len(tail), 610)

    def test_result_is_a_single_reprable_line(self):
        rendered = text_tail("first\nsecond")
        self.assertEqual(rendered, "'first\\nsecond'")
        self.assertNotIn("\n", rendered)