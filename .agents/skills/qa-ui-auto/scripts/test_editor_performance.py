from __future__ import annotations

import unittest

from qa_ui_auto.fixtures.editor_performance import TARGET_BYTES, java_like_bytes


class EditorPerformanceFixtureTests(unittest.TestCase):
    def test_fixture_sizes_and_bytes_are_deterministic(self) -> None:
        for target in TARGET_BYTES.values():
            first = java_like_bytes(target)
            second = java_like_bytes(target)
            self.assertEqual(len(first), target)
            self.assertEqual(first, second)
            self.assertIn(b"public final class EditorPerformanceFixture", first)
            self.assertIn(b"Java-like fixture line", first)


if __name__ == "__main__":
    unittest.main()
