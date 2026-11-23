"""Contracts for the nightly coverage policy and opt-in provider deferral."""
import argparse
import datetime as dt
import os
import unittest
from unittest.mock import patch

from qa_ui_auto import nightly
from qa_ui_auto.ci import make_plan


def args(**overrides):
    base = {'scope': 'smoke', 'head': '', 'base': '',
            'platforms': 'linux,windows,macos', 'modes': 'browser,native',
            'case_ids': '', 'features': '', 'tags': '', 'shards': '1',
            'nightly_policy': False, 'night_label': '', 'native_sample_percent': 0,
            'include_opt_in': False}
    base.update(overrides)
    return argparse.Namespace(**base)


class _Case:
    def __init__(self, case_id, tags=(), native_platforms=None, fixtures=()):
        self.id = case_id
        self.tags = list(tags)
        self.native_platforms = list(native_platforms or [])
        self.fixtures = list(fixtures)


class NightLabelTests(unittest.TestCase):
    def test_evening_label_precedes_the_beijing_small_hours_run(self):
        # 2026-11-21 is a Saturday; a delayed run created at 00:20 UTC still
        # belongs to Friday evening's nominal 19:17 UTC trigger.
        self.assertEqual(nightly.night_label(dt.datetime(2026, 11, 21, 0, 20, tzinfo=dt.timezone.utc)),
                         dt.date(2026, 11, 20))
        self.assertEqual(nightly.night_label(dt.datetime(2026, 11, 20, 19, 17, tzinfo=dt.timezone.utc)),
                         dt.date(2026, 11, 20))
        self.assertEqual(nightly.night_label(dt.datetime(2026, 11, 20, 19, 16, tzinfo=dt.timezone.utc)),
                         dt.date(2026, 11, 19))

    def test_windows_runs_for_the_friday_to_sunday_beijing_small_hours_runs(self):
        # The 03:17 Beijing runs on Fri/Sat/Sun come from nominal triggers on
        # UTC Thursday/Friday/Saturday (the night label).
        nights = nightly.DEFAULT_WINDOWS_NIGHTS
        enabled = {date for date in (dt.date(2026, 11, 19) + dt.timedelta(days=offset)
                                     for offset in range(7))
                   if nightly.windows_enabled(date, nights)}
        self.assertEqual({date.weekday() for date in enabled}, {3, 4, 5})
        for date in (dt.date(2026, 11, 22), dt.date(2026, 11, 23),
                     dt.date(2026, 11, 24), dt.date(2026, 11, 25)):
            self.assertEqual(nightly.platforms_for_night(['linux', 'windows', 'macos'], date, enabled=True),
                             ['linux', 'macos'])
        for date in (dt.date(2026, 11, 19), dt.date(2026, 11, 20), dt.date(2026, 11, 21)):
            self.assertEqual(nightly.platforms_for_night(['linux', 'windows', 'macos'], date, enabled=True),
                             ['linux', 'windows', 'macos'])

    def test_invalid_weekday_configuration_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'unknown nightly weekdays'):
            nightly.platforms_for_night(['linux'], dt.date(2026, 11, 20), enabled=True, nights='funday')


class TierBSelectionTests(unittest.TestCase):
    def cases(self, count=40):
        return [_Case(f'TC-{index:03d}') for index in range(count)]

    def test_always_set_and_one_window_are_kept_with_prerequisite_closure(self):
        cases = self.cases()
        selected, reasons, record = nightly.select(
            cases, {}, always_ids={'TC-000'}, percent=50, night=dt.date(2026, 11, 20))
        self.assertIn('TC-000', selected)
        self.assertEqual(len(selected), len(set(selected)))
        self.assertTrue(all(case_id in reasons for case_id in selected))
        self.assertLessEqual(len(selected), len(cases))
        self.assertEqual(record['sample_percent'], 50)
        window_index = dt.date(2026, 11, 20).toordinal() % 2
        self.assertEqual(record['window'], f'{window_index + 1}/2')

    def test_dependency_closure_pulls_in_the_prerequisite(self):
        cases = self.cases(10)
        dependencies = {'TC-003': ['TC-007']}
        selected, _, _ = nightly.select(cases, dependencies, always_ids={'TC-003'},
                                        percent=20, night=dt.date(2026, 11, 20))
        self.assertIn('TC-007', selected)

    def test_five_consecutive_nights_cover_every_shared_case_exactly_once(self):
        cases = self.cases(37)
        seen = []
        for offset in range(5):
            night = dt.date(2026, 11, 20) + dt.timedelta(days=offset)
            selected, _, record = nightly.select(cases, {}, always_ids=set(), percent=20, night=night)
            seen.extend(selected)
            self.assertEqual(record['selected'], len(selected))
            self.assertGreater(len(selected), 0)
        self.assertEqual(sorted(seen), sorted(case.id for case in cases))

    def test_full_percent_keeps_everything_and_bounds_are_validated(self):
        cases = self.cases(12)
        selected, _, record = nightly.select(cases, {}, always_ids={'TC-001'},
                                             percent=100, night=dt.date(2026, 11, 20))
        self.assertEqual(selected, [case.id for case in cases])
        self.assertEqual(record['window'], '1/1')
        for percent in (0, 101):
            with self.assertRaisesRegex(ValueError, 'native sample percent'):
                nightly.select(cases, {}, always_ids=set(), percent=percent, night=dt.date(2026, 11, 20))


class NightlyPlanTests(unittest.TestCase):
    def test_weekday_night_skips_windows_and_samples_native_only(self):
        plan = make_plan(args(scope='all', nightly_policy=True, night_label='2026-11-24'))
        self.assertEqual(plan['nightly']['platforms'], ['linux', 'macos'])
        self.assertFalse(plan['nightly']['windows'])
        entries = {entry['id']: entry for entry in plan['entries']}
        self.assertNotIn('windows-native', entries)
        self.assertTrue(any(key.startswith('linux-native') for key in entries))
        # Browser entries are not sampled; native entries are.
        native_ids = [case_id for entry in plan['entries'] if entry['mode'] == 'native'
                      for case_id in entry['selected_ids']]
        self.assertLess(len(native_ids), 300)
        self.assertTrue(any(reason.startswith('nightly: ')
                            for reason in plan['reasons'][native_ids[0]]))

    def test_weekend_night_keeps_windows_and_full_percent_restores_coverage(self):
        plan = make_plan(args(scope='all', nightly_policy=True, night_label='2026-11-20',
                              native_sample_percent=100))
        self.assertEqual(plan['nightly']['platforms'], ['linux', 'windows', 'macos'])
        self.assertTrue(plan['nightly']['windows'])
        self.assertEqual(plan['nightly']['sample_percent'], 100)
        for key, record in plan['nightly']['entries'].items():
            self.assertEqual(record['deferred'], [], key)

    def test_nightly_policy_requires_all_scope(self):
        with self.assertRaisesRegex(ValueError, 'nightly policy requires scope=all'):
            make_plan(args(scope='selected', case_ids='TC-010', nightly_policy=True,
                           night_label='2026-11-24'))


class OptInGapTests(unittest.TestCase):
    def test_scope_all_reports_opt_in_cases_as_declared_gaps(self):
        env = {name: '' for name in ('TAOMNI_QA_DEEPSEEK_KEY', 'TAOMNI_QA_DEEPSEEK_KEY_FILE',
                                     'TAOMNI_QA_OPENCODE_KEY', 'TAOMNI_QA_OPENCODE_KEY_FILE',
                                     'TAOMNI_QA_AGNES_KEY', 'TAOMNI_QA_AGNES_KEY_FILE')}
        with patch.dict(os.environ, env, clear=False):
            plan = make_plan(args(scope='all', platforms='linux', modes='native'))
        opt_in_gaps = [gap for gap in plan['gaps']
                        if 'credential' in gap['reason'] or 'opt-in' in gap['reason']]
        self.assertTrue(opt_in_gaps)
        self.assertTrue(all(gap['case'].startswith('TC-TAO-HOME-') for gap in opt_in_gaps))
        selected = {case_id for entry in plan['entries'] for case_id in entry['selected_ids']}
        self.assertFalse({gap['case'] for gap in opt_in_gaps} & selected)

    def test_configured_provider_keeps_the_cases_out_of_gaps(self):
        with patch.dict(os.environ, {'TAOMNI_QA_DEEPSEEK_KEY': 'test-key',
                                     'TAOMNI_QA_DEEPSEEK_KEY_FILE': ''}, clear=False):
            plan = make_plan(args(scope='all', platforms='linux', modes='native'))
        gaps = [gap for gap in plan['gaps']
                if 'credential' in gap['reason'] or 'opt-in' in gap['reason']]
        # The DeepSeek credential satisfies the default provider; only the case
        # that pins Agnes through its per-case policy override stays a gap.
        self.assertEqual([gap['case'] for gap in gaps], ['TC-TAO-HOME-047'])
        selected = {case_id for entry in plan['entries'] for case_id in entry['selected_ids']}
        self.assertIn('TC-TAO-HOME-013', selected)


if __name__ == '__main__':
    unittest.main()
