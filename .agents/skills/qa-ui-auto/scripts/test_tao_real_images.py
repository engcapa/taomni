"""Provider-specific image preparation and retained upload progress contracts."""
from copy import deepcopy
import unittest

from qa_ui_auto.steps import StepError
from qa_ui_auto.tao_real_images import assert_image_ready


class ImageReadyTests(unittest.TestCase):
    def state(self):
        return dict(uploadError="", transport={"files": [{"status": "fulfilled"}]}, chips=1,
                    tasks=[], prepared=[{"name": "picture.png", "bytes": "1234 bytes"}],
                    previews=["File will be sent with the message: 1234 bytes Close"])

    def test_go_requires_actual_local_metadata_and_truthful_context_preview(self):
        state = self.state()
        assert_image_ready(state, "opencode-go", "picture.png", 1234)
        for key, value in (("prepared", []), ("previews", ["File uploaded: 1234 bytes"]),
                           ("chips", 0), ("uploadError", "file unavailable")):
            broken = deepcopy(state)
            broken[key] = value
            with self.subTest(key=key), self.assertRaises(StepError):
                assert_image_ready(broken, "opencode-go", "picture.png", 1234)
        with self.assertRaises(StepError):
            assert_image_ready(state, "opencode-go", "picture.png", 9999)

    def test_deepseek_still_requires_completed_upload_and_percentage(self):
        state = self.state()
        with self.assertRaises(StepError):
            assert_image_ready(state, "deepseek-app", "picture.png", 1234)
        state["tasks"] = [{"percent": 100, "text": "completed 1234 / 1234 bytes 100%"}]
        assert_image_ready(state, "deepseek-app", "picture.png", 1234)
        state["tasks"][0]["percent"] = 50
        with self.assertRaises(StepError):
            assert_image_ready(state, "deepseek-app", "picture.png", 1234)


if __name__ == "__main__":
    unittest.main()
