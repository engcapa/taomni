import copy
import unittest
from types import SimpleNamespace

from qa_ui_auto.ci_sharding import schedule, validate_partition


def cases(ids, fixtures=None):
    return {cid: SimpleNamespace(fixtures=(fixtures or {}).get(cid, []), steps=[], tags=[]) for cid in ids}


def entry(ids, mode='native', platform='windows'):
    return dict(id=f'{platform}-{mode}', platform_key=platform, platform=platform,
                mode=mode, selected_ids=ids, case_digests={cid: cid for cid in ids},
                capabilities=['release'] if mode == 'native' else [], cache_key=platform,
                runner='windows-2025', arch='X64', linux_profile='', linux_wrapper='',
                desktop={}, rdp_unit_contracts=False)


class ShardingTests(unittest.TestCase):
    def test_selected_native_fans_out_on_every_platform_without_splitting_dependency(self):
        for platform in ('linux', 'windows', 'macos'):
            base = entry(['A', 'B', 'C', 'D'], platform=platform)
            shards, groups, builds = schedule([base], cases(base['selected_ids']), {'B': ['A']}, scope='selected', costs={})
            self.assertEqual(len(shards), 3)
            self.assertEqual(len(builds), 1)
            self.assertTrue(all(s['workers'] == 1 for s in shards))
            dependent = next(s for s in shards if 'B' in s['selected_ids'])
            self.assertEqual(dependent['selected_ids'], ['A', 'B'])
            self.assertEqual(len({s['build_id'] for s in shards}), 1)
            validate_partition(groups, shards)

    def test_browser_shared_cases_do_not_serialize_independent_cases(self):
        ids = ['A', 'B', 'C', 'D']
        shards, _, builds = schedule([entry(ids, 'browser')], cases(ids, {'A':['ssh_required'], 'B':['vnc_required']}), {}, scope='selected', costs={})
        self.assertEqual(len(shards), 2)
        self.assertFalse(builds)
        self.assertEqual({tuple(s['selected_ids']): s['workers'] for s in shards}, {('A','B'): 1, ('C','D'): 2})

    def test_single_case_keeps_one_runner_and_dependency_only_selection_keeps_order(self):
        for ids, deps in [(['A'], {}), (['A','B'], {'B':['A']})]:
            shards, _, _ = schedule([entry(ids)], cases(ids), deps, scope='selected', costs={})
            self.assertEqual(len(shards), 1)
            self.assertEqual(shards[0]['selected_ids'], ids)

    def test_explicit_one_disables_fanout_even_for_mixed_browser(self):
        ids = ['A','B']
        shards, _, _ = schedule([entry(ids, 'browser')], cases(ids, {'A':['ssh_required']}), {}, scope='selected', shards='1', costs={})
        self.assertEqual(len(shards), 1)
        self.assertEqual(shards[0]['workers'], 1)

    def test_weighted_balance_and_exact_once_cover(self):
        ids = ['A','B','C','D']
        base = entry(ids)
        shards, groups, _ = schedule([base], cases(ids), {}, scope='all', shards='2', costs={base['id']:dict(zip(ids,[100,90,10,5]))})
        self.assertEqual(sorted(s['estimated_seconds'] for s in shards), [100,105])
        broken = copy.deepcopy(shards); broken[0]['selected_ids'].append('A')
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            validate_partition(groups, broken)
        broken = copy.deepcopy(shards); broken.pop()
        with self.assertRaisesRegex(ValueError, 'missing'):
            validate_partition(groups, broken)

    def test_dual_desktop_shares_profile_build_but_not_execution_group(self):
        base = entry(['A']); dual = entry(['B'])
        dual.update(id='windows-native-dual', capabilities=['dual-display'])
        shards, groups, builds = schedule([base, dual], cases(['A','B']), {}, scope='selected', costs={})
        self.assertEqual(len(groups), 2)
        self.assertEqual(len(builds), 1)
        self.assertTrue(all('release' in s['capabilities'] for s in shards))

    def test_invalid_limits_and_missing_prerequisite_rejected(self):
        for shards in ('0','9','no'):
            with self.assertRaises(ValueError):
                schedule([entry(['A'])], cases(['A']), {}, scope='all', shards=shards)
        with self.assertRaisesRegex(ValueError, 'prerequisite'):
            schedule([entry(['A'])], cases(['A']), {'A':['B']}, scope='all', costs={})
