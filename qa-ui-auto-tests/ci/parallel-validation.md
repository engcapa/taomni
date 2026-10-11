# Platform sharding validation

Implementation branch: `perf/qa-platform-shards`.

## Scope and baseline

Baseline: [main run 38133668943](https://github.com/engcapa/taomni/actions/runs/38133668943),
commit `ce2c60abab25c9559c1c2dfa02decfe1c216b981`. Its workflow succeeded,
but the verified case reports contained three failures and no infrastructure
errors:

| Logical entry | Case | Failure |
|---|---|---|
| linux-native | TC-BACKUP-001 | Backup policy did not persist daily frequency |
| windows-native | TC-IDE-PARITY-005-05 | Completion option click intercepted |
| macos-native | TC-RDPS-PERF-03-photo-content | FPS ratio 0.933933 below 0.95 |

The implementation starts from main `a20a2a0efdc5e3295d80557954caef2908a7e623`.
That revision includes newer backup behavior and cases. Relative to baseline,
each browser platform adds `TC-BACKUP-CLOUD-002` and `TC-BACKUP-CLOUD-005`;
each ordinary native profile adds `TC-BACKUP-CLOUD-001` through `004`.
No baseline cases are removed. These source/scope differences and hosted runner
variability prevent interpreting a single before/after timing as an isolated
causal benchmark.

The full plan has 13 logical combinations, 38 execution shards and 6 native
producers. Linux has four separate build/desktop profiles. Each ordinary native
combination uses four serial shards; each Linux dual-display combination uses
one additional execution shard sharing its profile's release build. Browser
uses three Linux, four Windows and three macOS shards, with two workers in
independent shards and one worker in shared-fixture shards.

## Local verification

- Workflow tool suite: 319 tests, successful with one conditional skip.
- Updater packaging contracts: 14 tests passed.
- Wayland/multi-display contracts: 24 tests passed.
- Additional report test: missing shard remains an infrastructure failure;
  duplicate membership is rejected and failures retain logical group IDs.
- `qa_ui_auto.audit --gate`: passed.
- actionlint on both workflows: passed (shellcheck disabled).
- Actual full CLI plan: all baseline cases retained exactly once per combination.

This changes scheduling and artifact transfer, not product behavior; existing
executable cases provide retained-behavior coverage. No product YAML case was
added solely to mirror CI code; an existing cloud-backup case now waits for an
enabled Add button after a real macOS failure exposed its loading race. New unit tests exercise dependency preservation,
parallelism limits, weighted allocation, byte/mode preservation, invocation
identity, tamper rejection and complete report coverage.

## Hosted verification

- [Selected browser/native, all platforms and Linux profiles](https://github.com/engcapa/taomni/actions/runs/38150506299): 27/27 passed. All 18 native shards imported their runtime without compiling; each of six producer groups reported one identical binary hash across its three shards.
- [Selected independent browser cases](https://github.com/engcapa/taomni/actions/runs/38152451359): 6/6 passed, `workers=2` on Linux, Windows and macOS. Selection was `TC-015,TC-034`.
- [Additional selected mixed browser cases](https://github.com/engcapa/taomni/actions/runs/38151969486): successful; `TC-006` has SSH dependencies and was correctly separated from `TC-015`.
- [Initial full native, macOS](https://github.com/engcapa/taomni/actions/runs/38152650849): complete, 155/164 passed; nine screenshot scenarios failed. The workflow is green because reports are complete, not because every case passed. Baseline RDP performance failure did not recur.
- [macOS full rerun after consent handling](https://github.com/engcapa/taomni/actions/runs/38154756853): 163/164 passed, no infrastructure errors. All nine screenshot failures resolved; logs confirm the Python network prompt was accepted. `TC-BACKUP-CLOUD-001` clicked Add while configuration was loading (disabled button), fixed by waiting for the enabled selector in `f3c47247`.
- [macOS cloud cases after enabled-button wait](https://github.com/engcapa/taomni/actions/runs/38158442834): 4/4 passed, no skips/infrastructure errors.
- [Full browser, all platforms](https://github.com/engcapa/taomni/actions/runs/38150559073): passed, 1,075/1,075 case executions, no skips or infrastructure errors.
- [Full native, Linux four profiles and Windows](https://github.com/engcapa/taomni/actions/runs/38152202400): complete, no missing/invalid evidence. Windows 175/175 and default Linux 190/190 passed; all four dual-display cases passed. X11 186/190, VNC 185/190, Wayland 186/190. Twelve failures were newly added cloud backup cases with unavailable/locked Secret Service; VNC also failed the photo performance ratio.
- [Cloud backup sharded rerun, four Linux profiles](https://github.com/engcapa/taomni/actions/runs/38157402488): 16/16 passed after isolated Secret Service setup and real credential roundtrip validation (`372432dd`).
- [X11 cloud single-case control before fixture fix](https://github.com/engcapa/taomni/actions/runs/38157170599): passed, demonstrating prior-session state matters.
- [Continuous local/cloud backup sequence, four Linux profiles](https://github.com/engcapa/taomni/actions/runs/38158115255): 20/20 passed, five serial cases per runner, no skips/infrastructure errors.
- [VNC photo selected rerun](https://github.com/engcapa/taomni/actions/runs/38157466301): failed, ratio 0.907939 vs minimum 0.95 (full run 0.905258). No threshold changed. Reuses successful RDP unit contracts from 38152202400, with unchanged Rust sources/lockfile/toolchain/release configuration.
- [Unmodified branch-base main workflow photo control](https://github.com/engcapa/taomni/actions/runs/38158554085): failed the same FPS ratio gate, 0.947509 vs 0.95. Tests `a20a2a0` on Ubuntu 22.04 VNC with the original single-job build/run workflow. The original workflow also reproduces a failure, but these samples do not isolate the cause of the lower candidate ratios. This remains a performance limitation, not a passing case.

Browser measured runner case time (baseline entire suite versus candidate's
longest shard; excludes setup, queue and aggregate):

| Platform | Baseline cases / minutes | Candidate cases / minutes |
|---|---:|---:|
| Linux | 357 / 41.59 | 359 / 16.40 |
| Windows | 357 / 77.67 | 359 / 15.18 |
| macOS | 355 / 43.69 | 357 / 18.55 |

Including preparation and artifact upload, the span from first shard start to
last shard completion was 17.85 minutes on Linux, 21.60 on Windows and 20.07 on
macOS, versus baseline single-job times 43.25, 85.02 and 45.48 minutes.
Candidate sums of runner execution time were 46.25, 74.62 and 45.33 minutes
respectively; these are elapsed runner minutes, not billing multipliers.

Every candidate browser shard with independent cases reports `workers=2`;
shared-fixture shards report `workers=1`. Original reports and receipts are in
the run's `qa-*` artifacts; aggregate `passed` and `report_ok` are both true.

Results and measured timings above were inspected from original summaries,
execution receipts and producer logs. A green workflow alone is not an all-cases
pass: full-run case failures remain report content; selected runs require all
selected cases to pass.

## Regression found during hosted validation

Fresh macOS shards exposed a Python local-network permission dialog over the
screenshot fixtures. The OCR failure includes the exact system text “Allow
Python to find devices on local networks?”, and the capture/recording failures
are retained in the initial full native run. Failed IDs: `TC-SHOT-N1`, `N7`,
`N8`, `N9`, `N10`, `N11`, `N12`, `N14`, `N16`.

Commit `8de4c3fd` adds a hosted-only macOS System Events monitor for that specific
Python network dialog. It does not match app, microphone, screen-recording or
file prompts. Actions are recorded in `macos-fixture-consent.log`; an early
monitor exit fails setup. Dialog matching has focused Node tests. The existing
screenshot assertions remain intact. The full macOS rerun verified all nine previously failing screenshot scenarios.

Native longest-shard case time was 17.67 minutes on default Linux, 17.20 X11,
17.65 VNC, 17.73 Wayland, 18.96 Windows and 14.50 macOS (macOS corrected run).
These contain the failures described above and exclude build/desktop setup and
queue. The first complete Linux/Windows run waited for Wayland's producer:
its dual-display contracts took 25.6 minutes and the application binary was
missing from the restored cache, requiring another ~7 minute incremental build.
Build-matrix barriers and GitHub concurrency limits remain measurable costs.

The original baseline failures (`linux-native/TC-BACKUP-001`,
`windows-native/TC-IDE-PARITY-005-05`,
`macos-native/TC-RDPS-PERF-03-photo-content`) did not recur in the full candidate
runs. This does not erase their historical failures or prove those behaviors
are universally stable. Initial failures and focused corrections are separate
runs; no synthetic all-green full-run receipt is produced.

The Linux credential fixture now replaces a previously activated daemon only
inside the hosted private D-Bus session and verified run-owned XDG roots. A
`secret-tool` store/lookup/clear roundtrip proves readiness before the app starts.
Both independently sharded cloud cases (16/16) and continuous local/cloud backup
sequences (20/20) passed across all four Linux desktop profiles. No developer
keyring is touched. The four macOS cloud cases also passed after waiting for the
Add button to become enabled; that wait changes no acceptance assertion.

## Final status

All five implementation areas are delivered: browser concurrency, dependency-
preserving runner sharding, one native build per platform/profile, selected
fan-out, and complete grouped evidence with baseline comparison. Hosted full
runs covered all 13 original logical combinations, plus current-main cloud
backup cases. Discovered macOS consent, backup readiness and Linux Secret
Service issues have passing focused/retained-behavior evidence. The VNC photo
performance gate remains failing on both candidate and original workflow and
is not waived. Changes are pushed on `perf/qa-platform-shards`, not merged.

Validation did not use an independent sub-agent. No all-platform full run was
repeated after the focused environment/case fixes; the full runs and subsequent
focused corrections retain their distinct source/runner/case identities.
