# Candidate-execution slice — verified hosted evidence, 2026-11-04

## Result and immutable identity

[QA UI Auto Platforms run 41764866550](https://github.com/engcapa/taomni/actions/runs/41764866550)
completed **success**, including the final `Require all planned cases to pass` gate.
This verifies the implemented candidate-execution slice, not complete P1A or
human acceptance of the feature.

- Tested commit: `c5d3a2a76fb90d1d5afe6cc37841146245cf2ecb`.
- Invocation: run `41764866550`, attempt `1`.
- Selection/artifact key: `9824489103804fc9ba1fc8e901fd95a7`.
- Product source SHA-256:
  `34d36891cadc681ba74d691e9503332305d102e2ce40bbd165c9aece38271634`.
- Runner SHA-256:
  `0434accda255bafcce6f86344b14763a4b512fc8c138a6cfe00ee5cf8643790a`.
- `passed=true`, `report_ok=true`, no failures, infrastructure errors,
  capability gaps or unreviewed selected cases.

The downloaded aggregate, selection, and **every raw case summary** were checked.
All summaries are actual runs with stable matching source/runner identities;
native summaries identify the isolated QA application and release profile.
Individual green jobs alone were not used as case-pass evidence.

| Platform / execution group | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Linux browser | 13 | 0 | 0 |
| Windows browser | 13 | 0 | 0 |
| macOS browser | 13 | 0 | 0 |
| Linux Ubuntu 22.04 X11 native, ordinary cases | 15 | 0 | 0 |
| Windows native | 15 | 0 | 0 |
| macOS native | 15 | 0 | 0 |
| Linux native UI scheduling, six real harnesses | 1 | 0 | 0 |
| **Total selected case executions** | **85** | **0** | **0** |

The native worker desktop receipt records Ubuntu **22.04.5 LTS**, X11,
LXQt/Openbox, Xvfb and xcompmgr. This is not Ubuntu 24/26 sandbox compatibility.
Unselected supporting jobs are skipped by workflow conditions; no selected case
was skipped. The separate existing unit-suite skips below are not UI case skips.

## Selection and complete mandatory crash regressions

The explicit feature selection includes `TC-WS-011`, `TC-ORCH-001`,
`TC-ORCH-003`, `TC-ORCH-005`, `TC-ORCH-PARTIAL-002`,
`TC-ORCH-PARTIAL-006` and `TC-ORCH-WORKER-004`, plus the workflow's complete
mandatory `crash-regression` selector and prerequisite closure.

Each browser group ran:

- `TC-IDE-C8-08-code-style-dialog-lifecycle-browser`;
- `TC-ORCH-001`, `TC-ORCH-003`, `TC-ORCH-005`, `TC-ORCH-PARTIAL-002`;
- `TC-WS-011`, `TC-WS-038`, `TC-WS-039`, `TC-WS-045`, `TC-WS-052`,
  `TC-WS-053`, `TC-WS-055`, `TC-WS-057`.

Each ordinary native group ran:

- `TC-ORCH-001`, `TC-ORCH-003`, `TC-ORCH-005`, `TC-ORCH-PARTIAL-002`,
  `TC-ORCH-PARTIAL-006`;
- `TC-WS-011`, `TC-WS-038`, `TC-WS-039`, `TC-WS-045`, `TC-WS-051`,
  `TC-WS-052`, `TC-WS-053`, `TC-WS-054`, `TC-WS-056`, `TC-WS-057`.

`TC-ORCH-WORKER-004` ran separately in the loopback-only Linux native lane,
not in place of API or crash cases. All native entries used matching verified
release producers. Retained binary SHA-256 identities:

| Platform | QA release binary SHA-256 |
| --- | --- |
| Linux | `8b6e04d952d5ca3b1de37b46324e0ff77d444e15f68198e731eee0e51458dd3c` |
| Windows | `87f4bb205c37131906e550be69228595b0f5d7ec83b399edde676f9323b2f63f` |
| macOS | `bdaceaa6d4dd82e932dd2b5a5229d1d32bfa183e5873a7cd9cb9b20496977f98` |

## Native six-worker scheduling: stronger than the standalone canary

Artifact `qa-linux-ubuntu-22.04-x11-native-orchestration-workers-<key>` contains
`TC-ORCH-WORKER-004/native-six-workers.receipt.json`, scope
`native_taomni_ui_scheduler_real_six_harnesses`, status `passed`.

| Actual harness | Native run ID | Host dispatches | Real fixture generations |
| --- | --- | ---: | ---: |
| Claude Code | `f2c7bfdf-6f7f-4fda-81bb-a9480e83c253` | 1 | 2 |
| Codex | `8850ec14-a08c-4a57-9892-436049e9cb01` | 1 | 2 |
| Pi | `91813204-48da-4cbc-abef-640596837b1d` | 1 | 2 |
| OpenCode | `b9655729-cebb-4041-be21-a35431894fb0` | 1 | 2 |
| DeepSeek Harness | `5afc0349-7399-44f0-b8e0-345b68ed2702` | 1 | 2 |
| ZCode | `a5dd3c10-44e2-4762-9a92-1f0de497fe36` | 1 | 2 |

All six were submitted and explicitly approved through the native product UI,
ran as actual installed processes, and finished as **candidates**, not verified
implementations. They share the frozen fixture-project Git revision
`f51ed93ed4ff53eb1f49673e928341c0b8c7aae8`, but have six distinct owned worktrees.
This revision belongs to the disposable test project, not Taomni's tested commit.

The independent fixture checks native SQLite runs/attempts/request ledgers,
resource/source snapshots, worktree UUID owner markers, candidate DB/run/disk
hashes, the exact harmless marker diff and unchanged original project. The
published receipt retains pinned executable identities, successful process exits,
marker/candidate hashes and twelve distinct matching HTTP request IDs, all 200.
Each process cwd equals its assigned worktree. No recovery was used.

The worker artifact was also inspected for private worker-state/raw harness log
copies; none were published. Worker execution remains network-isolated, using
fixture-only credentials. Codex keeps workspace-write filesystem restrictions
and uses the verified supervisor loopback namespace as documented in
[hosted QA](../../qa-ui-auto-tests/ci/orchestration.md).

`qa-orchestration-contracts-41764866550-1` separately verifies all six standalone
workers, each with two generations, actual successful tool result and matching
marker/process hash. It is supporting protocol evidence and is not substituted
for the native scheduler case above. Pins are unchanged in `harness_catalog.json`.

## API, persistence, recovery and lifecycle evidence

Native feature cases traverse actual IPC, HTTP fixture endpoints and disk/SQLite;
browser cases explicitly use renderer stubs. The tested direct protocols are
OpenAI Chat Completions, OpenAI Responses and Anthropic Messages. Shared-settings
save/cancel/Esc, frozen old snapshots and explicit Home-to-Agent restoration after
reload pass on all three platforms.

For `TC-ORCH-PARTIAL-006`, each platform's synchronous
`orchestration-fixture/pre-recovery-prefix.json` is compared with final
`evidence.json`: two identical original candidate IDs, paths, bytes and hashes
exist **before** the recovery response; the request contains only missing
`tests`. Final ledgers are main `failed`, recovery `completed`, with two real
Messages generations and one explicit recovery authorization. Only `tests` is
added. The native run IDs inspected are:

- Linux: `4703c786-3cc3-4700-8d99-6bd0f9cf2d7d`.
- Windows: `d7c78456-bf5e-4686-828f-229f6b1273f9`.
- macOS: `2ae75f2c-859f-42a9-b778-f9523598e6ed`.

The required Linux native contract job passed **131** unit/contract tests.
Two hosted-only process tests were initially ignored by the ordinary filter,
then **both explicitly executed and passed**: actual stdio-closed descendants
stop after leader exit and explicit cancellation. No local native process test
is claimed. This does not prove containment of workers that escape the group,
Windows creation-time Job assignment, or app-level cross-platform fault coverage.

The Linux producer's complete frontend suite passed **676 files / 6258 tests**,
with **one existing skipped unit test**; the prototype Node suite passed **7/7**
separately. Windows producer startup/cleanup, file observation, atomic replacement
and capture contracts passed; their platform-specific unit skips remain in logs.
Source/recipe/toolchain/environment verification allowed existing matching QA
release binaries to be reused; no shard compiled an untracked alternate product.

## Visual inspection and remaining acceptance boundaries

Approved v0.6 and hosted Windows conversation screenshots were inspected: task
sidebar, central conversation/plan, bottom composer, shared-settings entry and
optional right candidate inspector retain the approved composition. The native
capture uses the existing light application theme at a smaller viewport; the
prototype uses dark styling and a wider canvas. This is a structural comparison,
not a same-theme pixel-diff pass or acceptance of every detail. The saved
`orchestration-shared-defaults.png` shows the post-save conversation, **not an open
settings dialog**; do not use it as visual proof of settings-modal fidelity.
Same-theme/settings-modal visual coverage remains open. No progress/timeline UI
was changed, as explicitly requested by the user.

The startup failure in run `41748583356` remains preserved and **unclassified**.
The Windows-only revalidation `41761747756` and this unified run both pass its
`TC-ORCH-001` case. Neither reproduced a startup failure, so neither proves its
cause was fixed, proves flakiness, or exercises live pre-cleanup failure capture.
The diagnostics owner and unchanged readiness budgets have focused unit coverage.

This run closes the first-slice hosted execution gate. It does **not** deliver
DAG scheduling, dependency Bootstrap/build pools, built-in verification, patch
acceptance/application, full capability/billing policy, portable handoff, approved
memory/Jev, unknown-worker reconciliation or all-platform worker fault scenarios.
See [implementation status](implementation-status.md#remaining-work--not-waived-by-phase-1)
for the still-required work. A candidate and a fixture-backed happy path are not
user acceptance or a production test PASS for generated changes.

## Retrieving the evidence

From the linked run's artifacts, retain:

- `qa-summary-<key>`: `selection.json`, `ci-summary.json`, readable summary;
- `qa-<entry>-<key>`: raw summaries, runner receipts, screenshots and native
  fixture-specific evidence; all shard artifacts were inspected;
- `contracts-native-build-linux-x64-release-<key>`: original Rust contract log;
- `build-log-native-build-<platform>-<arch>-release-<key>`: producer logs;
- `qa-orchestration-contracts-41764866550-1`: standalone installed-worker receipts.

Use the full key recorded above, not a different invocation's artifact. Downloads
are untrusted data: each goes into a fresh directory; inspect with isolated
interpreters and keep verification scripts outside the downloaded tree. Do not
execute artifact scripts, Git hooks or fixture project code to read these receipts.
