import unittest

from qa_ui_auto.dev_contract import evaluate, is_product_path, is_unit_test_path


class DevelopmentContractTests(unittest.TestCase):
    def test_product_change_without_case_is_advisory(self):
        result = evaluate(
            ["src/components/editor/CodeWorkspaceTab.tsx"],
            case_ids={"TC-001"},
            policy_ids={"TC-001"},
        )
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["warnings"]), 1)

    def test_case_change_with_matching_catalog_is_clean(self):
        result = evaluate(
            [
                "src/components/editor/CodeWorkspaceTab.tsx",
                "qa-ui-auto-tests/cases/TC-NEW.testcase.yaml",
            ],
            case_ids={"TC-001", "TC-NEW"},
            policy_ids={"TC-001", "TC-NEW"},
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["warnings"], [])

    def test_catalog_drift_is_an_error(self):
        result = evaluate(
            ["qa-ui-auto-tests/cases/TC-NEW.testcase.yaml"],
            case_ids={"TC-001", "TC-NEW"},
            policy_ids={"TC-001"},
        )
        self.assertFalse(result["ok"])
        self.assertIn("new=['TC-NEW']", result["errors"][0])

    def test_tests_are_not_product_files(self):
        self.assertFalse(is_product_path("src/components/editor/CodeWorkspaceTab.test.tsx"))
        self.assertTrue(is_unit_test_path("src/components/editor/CodeWorkspaceTab.test.tsx"))
        self.assertFalse(is_product_path("docs-feature/code-workspace-idea-parity/index.md"))


if __name__ == "__main__":
    unittest.main()
