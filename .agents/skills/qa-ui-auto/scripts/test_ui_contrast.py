import unittest

from qa_ui_auto.steps import StepError
from qa_ui_auto.ui_contrast import ratio


def layer(color, opacity=1, image="none"):
    return {"color": color, "opacity": opacity, "image": image, "effect": False}


class PaintContrastTest(unittest.TestCase):
    def test_translucent_white_surface_over_black(self):
        sample = {"foreground": "rgb(0, 0, 0)", "layers": [
            layer("rgba(255, 255, 255, 0.5)"), layer("rgb(0, 0, 0)")]}
        self.assertAlmostEqual(ratio(sample, True), 5.2808, places=3)
        with self.assertRaises(StepError):
            ratio(sample, False)

    def test_group_opacity_fades_foreground_and_background_together(self):
        sample = {"foreground": "rgb(0, 0, 0)", "layers": [
            layer("rgb(255, 255, 255)", opacity=0.5), layer("rgb(255, 255, 255)")]}
        self.assertAlmostEqual(ratio(sample, True), 3.9767, places=3)

    def test_visible_gradient_requires_pixel_evidence(self):
        sample = {"foreground": "rgb(0, 0, 0)", "layers": [
            layer("rgba(0, 0, 0, 0)"), layer("rgb(255, 255, 255)", image="linear-gradient(...)")]}
        with self.assertRaises(StepError):
            ratio(sample, True)
        sample["layers"][0] = layer("rgb(255, 255, 255)")
        self.assertEqual(ratio(sample, True), 21)
