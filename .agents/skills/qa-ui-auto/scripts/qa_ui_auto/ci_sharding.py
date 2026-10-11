"""Deterministic, dependency-preserving scheduling for every hosted QA entry."""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
import json
import math
from pathlib import Path

COSTS = Path('qa-ui-auto-tests/ci/durations.json')
SHARED = {'ssh', 'vnc', 'ard'}


def components(ids, dependencies):
    parent = {cid: cid for cid in ids}

    def root(cid):
        while parent[cid] != cid:
            parent[cid] = parent[parent[cid]]
            cid = parent[cid]
        return cid

    for cid in ids:
        for previous in dependencies.get(cid, []):
            if previous not in parent:
                raise ValueError(f'prerequisite unavailable for {cid}: {previous}')
            parent[root(cid)] = root(previous)
    groups = {}
    for cid in ids:
        groups.setdefault(root(cid), []).append(cid)
    return list(groups.values())


def schedule(entries, by_id, dependencies, *, scope, shards='auto', browser_workers=2, costs=None):
    from .ci import capabilities
    if shards != 'auto' and (not str(shards).isdigit() or not 1 <= int(shards) <= 8):
        raise ValueError('shards must be auto or an integer from 1 to 8')
    if not 1 <= browser_workers <= 4:
        raise ValueError('browser workers must be from 1 to 4')
    if costs is None:
        costs = json.loads(COSTS.read_text(encoding='utf-8'))['entries'] if COSTS.exists() else {}
    scheduled, groups = [], []
    for entry in entries:
        ids = entry['selected_ids']
        groups.append({'id': entry['id'], 'selected_ids': ids})
        weights = costs.get(entry['id'], {})
        def cost(cid):
            return max(1.0, float(weights.get(cid, 30 if entry['mode'] == 'native' else 15)))
        units = components(ids, dependencies)
        buckets = {}
        for unit in units:
            caps = capabilities([by_id[cid] for cid in unit], entry['mode'])
            serial = entry['mode'] == 'native' or bool(SHARED.intersection(caps)) or len(unit) > 1
            buckets.setdefault('serial' if serial else 'parallel', []).append(unit)
        # Explicit 1 retains a single VM, and shared fixtures serialize that VM.
        if shards == '1':
            buckets = {'serial' if 'serial' in buckets else 'parallel': units}
        counts = {k: 1 for k in buckets}
        limit = 4 if shards == 'auto' else int(shards)
        limit = max(limit, len(buckets))
        total = sum(cost(cid) for cid in ids)
        if shards == 'auto':
            # Selected native cases have no shared desktop across VMs; one build
            # serves all shards, so even short independent selections can fan out.
            desired = min(limit, len(units)) if scope == 'selected' and entry['mode'] == 'native' else min(limit, max(len(buckets), math.ceil(total / 900)))
        else:
            desired = min(limit, len(units))
        while sum(counts.values()) < desired:
            choices = [k for k in buckets if counts[k] < len(buckets[k])]
            if not choices:
                break
            key = max(choices, key=lambda k: sum(cost(cid) for u in buckets[k] for cid in u) / counts[k] / (browser_workers if k == 'parallel' else 1))
            counts[key] += 1
        partitions = []
        for key, batch in sorted(buckets.items()):
            bins = [[] for _ in range(counts[key])]
            loads = [0.0] * len(bins)
            for unit in sorted(batch, key=lambda u: (-sum(cost(cid) for cid in u), u[0])):
                index = min(range(len(bins)), key=lambda i: (loads[i], i))
                bins[index].extend(unit)
                loads[index] += sum(cost(cid) for cid in unit)
            for assigned, load in zip(bins, loads):
                assigned_set = set(assigned)
                partitions.append(([cid for cid in ids if cid in assigned_set], key, load))
        for index, (assigned, key, load) in enumerate(partitions):
            shard = deepcopy(entry)
            shard.update(group_id=entry['id'], shard_index=index, shard_count=len(partitions),
                         id=entry['id'] if len(partitions) == 1 else f"{entry['id']}-shard-{index + 1}",
                         selected_ids=assigned, estimated_seconds=round(load, 2),
                         workers=min(browser_workers, len(assigned)) if key == 'parallel' else 1)
            shard['capabilities'] = capabilities([by_id[cid] for cid in assigned], entry['mode'])
            # Preserve the parent's optimized build requirement even when only
            # one shard owns a performance case. One profile, one binary.
            if 'release' in entry['capabilities']:
                shard['capabilities'] = sorted(set(shard['capabilities']) | {'release'})
            shard['case_digests'] = {cid: entry['case_digests'][cid] for cid in assigned}
            shard['rdp_unit_contracts'] = entry['rdp_unit_contracts'] and index == 0
            scheduled.append(shard)
    validate_partition(groups, scheduled)
    optimized = {e["cache_key"] for e in scheduled if e["mode"] == "native" and "release" in e["capabilities"]}
    for e in scheduled:
        if e["mode"] == "native" and e["cache_key"] in optimized:
            e["capabilities"] = sorted(set(e["capabilities"]) | {"release"})
    builds = {}
    for entry in scheduled:
        entry['build_id'] = ''
        if entry['mode'] != 'native':
            continue
        profile = 'release' if 'release' in entry['capabilities'] else 'debug'
        key = f"native-build-{entry['cache_key']}-{profile}"
        entry['build_id'] = key
        if key not in builds:
            builds[key] = {**deepcopy(entry), 'id': key, 'profile': profile, 'capabilities': [], 'rdp_unit_contracts': False}
        build = builds[key]
        build['capabilities'] = sorted(set(build['capabilities']) | set(entry['capabilities']))
        build['rdp_unit_contracts'] |= entry['rdp_unit_contracts']
    return scheduled, groups, list(builds.values())


def validate_partition(groups, entries):
    if len({e['id'] for e in entries}) != len(entries):
        raise ValueError('duplicate shard entry IDs')
    if len({g['id'] for g in groups}) != len(groups):
        raise ValueError('duplicate shard group IDs')
    if {e.get('group_id', e['id']) for e in entries} != {g['id'] for g in groups}:
        raise ValueError('shard groups differ')
    for group in groups:
        shards = [e for e in entries if e.get('group_id', e['id']) == group['id']]
        actual = Counter(cid for e in shards for cid in e['selected_ids'])
        if actual != Counter(group['selected_ids']) or any(v != 1 for v in actual.values()):
            raise ValueError(f"missing or duplicate shard cases: {group['id']}")
