import unittest
from ci_multi_display import monitor_configuration


class MonitorConfigurationTests(unittest.TestCase):
    def state(self):
        def output(name, width, height, scales):
            return ((name, "QA", "virtual", "1"), [(name + "-mode", width, height, 60.0, 1.0, scales, {})], {})
        return (42, [output("A", 1920, 1080, [1.0]), output("B", 2560, 1440, [1.0, 2.0])], [], {})

    def test_uses_advertised_outputs_and_modes_with_distinct_scales(self):
        serial, monitors = monitor_configuration(self.state())
        self.assertEqual(serial, 42)
        self.assertEqual(monitors, [(0, 0, 1.0, 0, True, [("A", "A-mode", {})]),
                                    (1920, 0, 2.0, 0, False, [("B", "B-mode", {})])])

    def test_does_not_claim_dual_or_mixed_dpi_when_the_os_cannot_supply_it(self):
        state = self.state()
        with self.assertRaisesRegex(RuntimeError, "two Mutter outputs"):
            monitor_configuration((42, state[1][:1], [], {}))
        state[1][1][1][0][5].remove(2.0)
        with self.assertRaisesRegex(RuntimeError, "lack real mode"):
            monitor_configuration(state)

    def test_output_enumeration_order_is_not_monitor_identity(self):
        state = self.state()
        expected = monitor_configuration(state)
        self.assertEqual(monitor_configuration((42, state[1][::-1], [], {})), expected)


if __name__ == "__main__":
    unittest.main()
