"""Contracts for causal diagnostic controls and original CPU observations."""
from unittest import TestCase

from workspace_perf.diagnose import phases, resource_delta


class IdleDiagnosticTest(TestCase):
    def test_every_intervention_has_an_original_control_immediately_after_it(self):
        sequence = list(phases())
        self.assertEqual(sequence[0], ('original-0', ''))
        self.assertEqual(len(sequence), 13)
        for index in range(1, len(sequence), 2):
            self.assertTrue(sequence[index][1])
            self.assertEqual(sequence[index + 1][1], '')
            self.assertTrue(sequence[index + 1][0].startswith('original-'))

    def test_cpu_delta_retains_raw_counters_and_rejects_reused_pid_time(self):
        before = [{'pid': 1, 'startTicks': 100, 'cpuTicks': 20, 'pssKiB': 100},
                  {'pid': 2, 'startTicks': 200, 'cpuTicks': 50, 'pssKiB': 200}]
        after = [{'pid': 1, 'startTicks': 100, 'cpuTicks': 220, 'pssKiB': 1024},
                 {'pid': 2, 'startTicks': 999, 'cpuTicks': 900, 'pssKiB': 2048}]
        result = resource_delta(before, after, 5, 100)
        self.assertEqual(result['cpuDeltaTicks'], 200)
        self.assertEqual(result['cpuCoreFraction'], .4)
        self.assertEqual(result['pssMiB'], 3)
        self.assertIs(result['before'], before)
        self.assertIs(result['after'], after)

    def test_incomplete_memory_or_empty_process_observation_fails(self):
        for rows in ([], [{'pid': 1, 'startTicks': 100, 'cpuTicks': 20, 'pssKiB': None}]):
            with self.subTest(rows=rows), self.assertRaises(AssertionError):
                resource_delta([], rows, 5, 100)
