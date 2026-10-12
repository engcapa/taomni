# Shared Linux build validation

Implementation branch: `perf/qa-shared-linux-build`. Hosted validation tests
commit `0403f297d4af80bf098200e5e26700f8b23c3088`; the subsequent documentation
commit only records these results. No product source, case selection or
performance threshold changed.

## Final hosted results

| Run | Scope | Verified case results | Elapsed |
|---|---|---:|---:|
| [Main baseline 38186550832](https://github.com/engcapa/taomni/actions/runs/38186550832) | All platforms, browser/native, four Linux desktops | 2,178/2,178 passed | 88m39s |
| [Candidate full 38216946315](https://github.com/engcapa/taomni/actions/runs/38216946315) | Same scope, contracts enabled | 2,178/2,178 passed | 46m25s |
| [Candidate selected 38220115163](https://github.com/engcapa/taomni/actions/runs/38220115163) | TC-015, TC-034; all platforms and four Linux desktops | 18/18 passed | 12m17s |

Elapsed is workflow creation to final update, including queue, setup and
collection. The baseline revision is
`863aca1ba7e1d0353c74aeb597a898b7f275df0c`. Full execution retains 38 shards:
10 browser shards (1,075 executions) and 28 serial native shards (1,103
executions, including all four Linux dual-display checks). Final
`ci-summary.json` has `passed=true`, `report_ok=true`, no failures and no
infrastructure errors in both candidate runs. These are verified report
results, not an inference from green job status.

The full run passed Linux ordinary native 190/190 on each desktop, Windows
175/175 and macOS 164/164. Each Linux dual-display job passed its one case.

Selected uses `native_release=true`, `shards=auto`, `browser_workers=2` and
`run_rdp_unit_contracts=false`. The successful Rust contracts in the full run
finished before selected was dispatched, on the identical code revision,
toolchain and release configuration. Selected browser reports each record
`workers=2` and two passed cases on Linux, Windows and macOS. Its 12 native
jobs each record `workers=1` and one passed case: two separate runners per
native platform/desktop. Thus independent selected cases fan out across
runners while retaining serial execution inside each native runner.

## Build and cache evidence

Native producers fall from six to three: Ubuntu 22.04 x64, Windows x64 and
macOS ARM64. All four Linux desktop profiles import the Ubuntu 22.04 artifact.
All 28 full-run native shard build logs confirm verified artifact import with
no compilation. Both candidate runs report these identical build hashes:

| Producer | SHA-256 |
|---|---|
| Linux x64 release | `49ff7e1a3f5471f067bc3edc5c133888df9b4b83f10676adc431dacb8b0cd57a` |
| Windows x64 release | `aacb175844bd566cf5ea1fbecff02f1b3c8d28682f01c8bcf3277a89e5bffd04` |
| macOS ARM64 release | `85c4669b6db0decbb8ab523d18925d54ce61bb5b66df66aa2a5a8209d547dfbf` |

Each producer log reports reuse of a verified QA build whose source, recipe,
toolchain and environment match. Full-run producer job durations, including
setup, restore, verification and export, were Linux 2m25s, Windows 5m27s and
macOS 2m07s. Selected durations were 2m44s, 3m50s and 2m00s respectively.

Full-run Linux VNC dual-display job `114704899702` shows exact remote cache
hits for the staged PipeWire 1.0.9 overlay and pinned tauri-driver 2.0.4.
Selected Windows job `114715790464` shows a tauri-driver cache hit, successful
native Python PATH/probe checks, and a pip cache hit. App caches retain strict
build identity verification; contracts use a separate Rust target cache that
can seed from app intermediates. Build/contracts jobs skip desktop setup.

These are GitHub remote caches restored onto fresh disposable runners. They
do not depend on a previous runner disk surviving. Cache availability follows
GitHub branch scoping and eviction: this branch can read eligible main caches,
but caches newly saved only on this feature branch do not automatically become
available to main after merge. Main may need to populate those keys once.
Missing caches rebuild normally; a cache hit still requires verification.

## Timing interpretation and remaining cost

The measured full-run reduction is 42m14s (47.6%). Both runs have the same case
scope, but this is not an isolated benchmark of the workflow change: cache
warmth, hosted machine speed, package mirrors and scheduling differ. In
particular, all three final producers reused app caches; an earlier candidate
had a cold macOS build taking 22m46s for Rust compilation alone.

Plan took 1m15s. macOS consumers started at 07:21:29 UTC after their producer
finished at 07:21:22; Linux consumers started at 07:21:38 after their producer
finished at 07:21:36. Neither waited for Windows (finished 07:24:38) or Rust
contracts (finished 07:35:23). This verifies independent platform release.

Runner admission remains a limit. The last Linux consumer started 19m43s after
its producer completed. The final X11 shard ran from 07:40:37 to 08:03:37,
including setup; cases took 17m16s. Aggregation took 33s. Sorting matrices by
estimated duration does not guarantee GitHub starts them in that order.
Observed scheduling admitted approximately 20 simultaneous jobs. The selected
run overlapped the full run from 07:51:37, after all full jobs had started, so
its 12m17s is not an isolated idle-repository timing.

Rust contracts succeeded in 16m12s. Even with an exact contracts cache hit,
the root test target took about 5m50s to compile and rdp-probe about 6m05s.
The cache does not eliminate all compilation/linking. These contracts remain
required by the final result but no longer block publishing application builds.

## Validation history and checks

- [38211022567](https://github.com/engcapa/taomni/actions/runs/38211022567) was cancelled to correct aggregate failure records. Supporting-job failures now retain the typed infrastructure-error schema and fail the final result.
- [38211209147](https://github.com/engcapa/taomni/actions/runs/38211209147) exposed Windows adapter PATH conversion, an X11 apt timeout, X11 rich-clipboard `CB_RESPONSE_FAIL`, and VNC photo FPS ratio 0.9274358 below 0.95. This failed iteration is not used as a successful-suite speed measurement.
- [38214496185](https://github.com/engcapa/taomni/actions/runs/38214496185) and [38214734104](https://github.com/engcapa/taomni/actions/runs/38214734104) exposed an unsupported adapter `--version` readiness probe before cases ran. Windows PATH now uses `cygpath -w`; both readiness probes use supported `--help`.
- The final full run reruns the entire scope on the corrected revision and passes the previously failing cases. No assertion or threshold was weakened. One successful run does not establish that intermittent host/performance failures cannot recur.
- Workflow tool contracts ran 329 tests successfully with one conditional skip; Node contracts passed 15 tests and desktop contracts passed 24 tests. Focused sharding, artifact compatibility and build-pipeline tests passed locally. Workflow actionlint (shellcheck disabled), shell syntax checks and `qa_ui_auto.audit --gate` passed.

The existing executable cases validate retained behavior. Added unit coverage
checks shared Linux build planning, producer/consumer compatibility and
workflow dependencies; no product case was added solely for CI scheduling.
Original summaries and receipts remain in each linked run's artifacts. All
results for the final full run belong to that one invocation; earlier focused
passes have not been combined into a synthetic full-suite result.
