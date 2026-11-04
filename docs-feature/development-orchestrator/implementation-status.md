# Development orchestrator implementation status

Updated: 2026-11-04. Design baseline: `a13e34dc7`, branch
`feat/development-orchestrator`. The user reauthorized implementation after the
approved v0.6 design commit, including staged English commits and hosted QA.
This file records implementation separately from acceptance evidence.

## Phase 1 — shared configuration, conversation UI and candidate execution

Implemented in the working branch:

- The approved v0.6 composition: project/task sidebar, conversation and composer,
  optional source/candidate inspector, shared settings and explicit recovery.
  Home and command-palette entries open the real surface, not the old placeholder.
  Existing workspace roots and proxy settings UI are reused.
- Shared versioned resources/default roles, Vault references and per-resource
  application/custom/no-proxy modes. Saving affects future submissions; submitted
  tasks retain their effective settings. Resource deletion revokes future dispatch
  from older task snapshots. Cost coefficients are user-defined, not market prices.
- Eight-table native store, OS owner lock, command idempotency, revision checks,
  atomic outcome/attempt/request-ledger commit, bounded global admission,
  cancellation token registration under the owner lock and restart interruption.
  An unknown process outcome does not release its reservation or redispatch.
- Text context snapshots include actual project rules and selected source contents,
  bounded UTF-8 input, secret redaction and hashes. The immutable output manifest
  binds the goal, source identities/paths/hashes/contents and expected members.
- Independent streamed OpenAI Chat Completions, OpenAI Responses and Anthropic
  Messages invocations with explicit terminal handling, usage and refusal/truncation
  outcomes. No automatic retries, tools, continuation, fallback or repair calls.
  Old chat-provider request/stream/wire code is extracted with compatibility tests.
- Incremental NDJSON candidates are retained on disk before later truncated or
  invalid output. A candidate is neither verified nor accepted. One document
  recovery requires explicit consent, targets only missing members, and cannot loop.
- Development submissions freeze a clean Git commit; execution creates a detached
  worktree at that commit. A configured normalized launcher receives literal argv,
  owned worktree/state placeholders and a stdin prompt. It must return a successful
  terminal NDJSON result and successful process exit. No shell interpolation is
  introduced. Native CC has a separate noninteractive default adapter; other harness
  labels are not treated as readiness without an explicit launcher.
- Native tasks outlive renderer navigation. Explicit application exit asks about
  unfinished runs and waits for owned execution cleanup. Candidates and worktrees
  are retained. Backend safe-exit failure keeps the app open.
- Browser stubs explicitly produce deterministic preview data and do not claim
  native network, worker, filesystem or test success.

### Source boundaries and compatibility

Core state/lifecycle/store/settings, context compilation, output framing and
execution supervision remain separate owners in the four planned responsibility
directories. UI components/state/effects are split by ownership and lifecycle.
Old AI command routes were moved out of the oversized central router into
`commands/ai_routes.rs`; the compatibility checker follows those explicit routes
and retains the original public IPC and literal-event baseline. This is routing
extraction, not a new command namespace for old features. Locale dictionaries and
generated protocol bindings keep the repository's explicit declarative exceptions.

## QA wiring (not runtime results)

See [hosted QA](../../qa-ui-auto-tests/ci/orchestration.md) for exact
execution/isolation contracts.

| Case | Required behavior and evidence boundary |
| --- | --- |
| TC-WS-011 | Home/palette entry, empty conversation and retained global-search behavior |
| TC-ORCH-001 | Shared settings save/cancel, old task snapshots and reload |
| TC-ORCH-PARTIAL-002 | Complete prefix retained, no hidden second request, one explicit recovery; native DB/file/hash/ledger proof |
| TC-ORCH-003 | Responses request with actual source contents and native candidate publication |
| TC-ORCH-005 | Chat Completions request and shared-resource controls |
| TC-ORCH-WORKER-004 | Linux native UI dispatch through Taomni to all six installed real harnesses; real worktrees, tool results, request ledger, marker/diff, pinned process and artifact hashes |
| TC-ORCH-PARTIAL-006 | Native no-newline complete item tail survives truncation; synchronous read-only recovery-arrival proof binds the two prefix candidate IDs/hashes before adding only missing tests |

Native API fixtures exercise real IPC/network/disk boundaries; browser versions
exercise the production renderer against explicit stubs. The standalone six-worker
canary is supporting protocol/CLI evidence only. It cannot replace the native UI
case. The worker lane is loopback-network-isolated and uses the same verified
release build producer as ordinary native cases. Other native services and the
complete mandatory `crash-regression` suite remain in their ordinary lanes.

### Local checks actually executed

No local product browser/native case, live fixture endpoint or real worker was run.

- Node **22.23.4**, pnpm **10.33.0**: 111 focused Vitest tests passed across nine
  UI/store/navigation/safe-exit files; `tsc -b` passed. After repairing the test
  runner boundary, the complete local frontend unit suite passed **676 files /
  6258 tests**, with **one existing skipped test**. Prototype Node tests (7) and
  IPC route-checker tests (3) passed separately; no application was launched.
- `cargo test --lib orchestration:: --no-default-features --features voice-capture
  -j 2`: **30 passed**, none failed/ignored. Includes context/manifest/framing,
  store/settings, capacity, cancel-before-spawn, unknown ownership and atomic finish.
- Same unit feature configuration: `llm::invocation` **36 passed**;
  `go_compatibility_tests` **22 passed**. A final combined root-unit run of
  `llm::invocation llm::openai_compat llm::anthropic orchestration::` passed
  **88 tests**, none failed/ignored. After the final safe-exit integration change,
  the combined `orchestration:: app_exit::` run passed **33 tests**. The later
  dispatch/tail/Unix-cleanup repair passed **53 unit tests**, with **two hosted-only
  real-process tests ignored locally**. Those ignored tests are explicitly run
  in the hosted native contract job and are not claimed as local passes.
- An additional focused stub/safe-exit run passed **7 tests** (including the four
  safe-exit tests already in the 111-test run); three new browser-stub tests cover
  immutable defaults, explicit recovery and resource revocation.
- Unit-only system workaround: the host PipeWire 0.3.48 headers cannot build
  pipewire-rs's enabled API. An isolated verified PipeWire **1.0.9** prefix was
  built outside the repository and passed through pkg-config/library variables.
  No product dependency or system library was replaced. Completely disabling all
  default features exposes existing unguarded voice-capture accesses; enabling
  `voice-capture` avoids that unrelated unsupported unit configuration.
- Source compatibility, boundaries and 800-line checks passed. Formatting check
  initially identified new route formatting; it was corrected with rustfmt.
- Fixture/QA-adapter/planner checks are pure offline units/static validation;
  their precise counts and final hosted evidence are recorded in phase commits
  and subsequent updates, not inferred from authored cases.

### Hosted evidence

- Pushed phases: `620e04a0b` (protocol extraction/invocation), `888218a04`
  (candidate runtime/UI/hosted wiring), `a54d479be` (mandatory crash-set registration).
- [Run 41674669109](https://github.com/engcapa/taomni/actions/runs/41674669109)
  failed checkout because the dispatch used a short SHA; no test ran. Corrected
  subsequent dispatches use the full immutable SHA.
- [Run 41675128700](https://github.com/engcapa/taomni/actions/runs/41675128700)
  failed mandatory crash-set unit assertions because the new tagged recovery case
  was not yet registered in the exact expected/smoke sets. Fixed in `a54d479be`;
  all four crash-planning unit tests then passed. Preserve existing crash cases.
- [Run 41675950537](https://github.com/engcapa/taomni/actions/runs/41675950537),
  pinned to `a54d479be718be3b7198df80fb9a103db4cb267a`, passed planning and
  started the three-platform browser/native release pipeline. The supporting real
  harness installer failed before worker execution; a follow-up adds safe
  harness/stage diagnostics rather than exposing private logs or treating skips
  as success. Browser/native results and complete crash evidence remain pending.

- Do not interpret green individual browser jobs as case acceptance. The raw Linux
  receipt from run `41675950537` contains **9 passed / 4 failed / 0 skipped**:
  ORCH-001/003/005/PARTIAL-002 each failed after reload because application-wide
  navigation deliberately restarts at Home. The correction preserves reload and
  all result assertions, explicitly reopens Agent from Home, then verifies restored
  tasks/candidates. Final aggregation, not the job exit, remains authoritative.
- In [run 41678202559](https://github.com/engcapa/taomni/actions/runs/41678202559)
  (`ce2b252a465d64a28c6c70682875185554a70959`), all **six pinned harness
  installations completed**, including the ZCode source build. Actual worker
  execution was blocked by an isolation verifier reading the host sysfs network
  mount after `unshare --net`; the correction must query current kernel network
  interfaces and still require exactly loopback. No direct/networked fallback.

- Corrected [run 41679954935](https://github.com/engcapa/taomni/actions/runs/41679954935)
  (`66659b0523d26293441c4bbe01c737940d47038d`) has downloaded raw browser
  summaries confirming **Linux 13/13, macOS 13/13 and Windows 13/13**, with no
  failures/skips, after the explicit Home-to-Agent reopen. This includes the ORCH
  API UI cases, retained entry/global-search case and all applicable browser crash
  regressions. The raw final aggregate also verifies **macOS native 14/14** using
  matching release WebView identity. Downloaded native partial/recovery evidence
  independently confirms two Anthropic generations, main-failed/recovery-completed
  ledgers, one recovery authorization and the three candidate files' SHA-256 hashes.
  **Windows native failed 14/14**: initial ORCH cases failed the fixture's project
  path identity check; subsequent cases hit a retained SQLite read connection
  during reset. Linux native did not run because the Linux build's frontend unit
  stage incorrectly collected the Node-only prototype test with Vitest. No native
  missing or failed result is counted as a pass.
- The same run's isolated standalone canary actually executed real harnesses:
  **Claude Code / Pi / ZCode passed**, each with two protocol generations,
  matching real tool result, pinned process identity and an owned marker artifact.
  **Codex failed** because no owned marker was produced despite final stdout;
  **OpenCode failed** its initial fixture request/final-result validation;
  **DeepSeek Harness failed** due to an extra failed fixture request. No failed
  worker is treated as passed, and none of these standalone outcomes establishes
  native Taomni scheduling. All six remain required.

Follow-up repairs after that failed run preserve all checks:

- `844424e6c` gives the seven Node-only prototype tests their own required hosted
  `node --test` command/log; Vitest discovery retains all 676 product test files.
- `5176f8a7f` compares native fixture project directories with filesystem identity
  and deterministically closes read-only SQLite connections/cursors. Eighteen
  adapter/reset boundary units passed; Windows execution must be rerun.
- The fixture follow-up supplies Codex's explicit tool workdir/non-login setting,
  suppresses source-verified auxiliary title generation in OpenCode/DeepSeek, and
  adds bounded closed-set failure diagnostics. Previous masked 422 responses do
  not establish their exact cause; only a new actual hosted run can validate the
  configuration. Pins, marker ownership, successful tool results and the two-call
  requirement remain strict.

Additional verified receipts and reliability repairs:

- In [run 41740668667](https://github.com/engcapa/taomni/actions/runs/41740668667)
  (`27af621e0b8350095d2159047f2e29bfc3e82ce0`), downloaded Windows native
  summaries now confirm **14/14 passed, zero failed/skipped**, after physical path
  identity and deterministic read-connection cleanup. The Responses fixture
  independently records one real generation, a completed main request, no recovery
  and a matching candidate-file hash. Other Windows cases reset successfully.
- [Run 41743820673](https://github.com/engcapa/taomni/actions/runs/41743820673)
  (`025a007f527f22cf35ce7d37e2924c960572c211`) confirms **five standalone real
  harnesses passed**: Claude Code, Pi, OpenCode, DeepSeek Harness and ZCode.
  OpenCode's pinned CLI quote-escapes positional prompt text; using its verbatim
  stdin path resolves the demonstrated fixture metadata failure without loosening
  parsing. **Codex remains failed** with a genuine bwrap tool result reporting
  EPERM; workspace-write and network namespace protection remain enabled.
- `71c4faec8` repairs three independently reviewed reliability defects: resource
  revocation/cancellation is rechecked with short spawn under the owner lock;
  complete no-newline candidate tails survive provider truncation while the pack
  stays failed/partial; Unix process groups require checked bounded termination
  evidence independent of a cached leader exit. Pure units passed; two hosted-only
  same-group descendant scenarios are wired into required native contracts.
- On 2026-11-04 the user explicitly asked to keep process/progress presentation
  unchanged. No new per-tool timeline, token display or progress UI is introduced
  by these reliability and validation repairs.

Full hosted product acceptance, Linux native crash evidence and six-harness
scheduling are not complete at this checkpoint.

## Remaining work — not waived by phase 1

The first slice is not complete P1A and is not a general autonomous development
orchestrator. The following planned contracts still need implementation and their
own behavior evidence:

1. True dependency scheduling across approved implementation/review/verification
   nodes, deterministic queueing and role-resource selection beyond the current
   one-resource-per-submission templates.
2. BootstrapRecipe/Receipt, private dependency materialization, fingerprinted build
   pools and Heavy locks; built-in verification with archived binaries/reports.
   Workers currently receive an explicit no-install instruction and no automatic
   dependency bootstrap. A CLI result is never presented as a test PASS.
3. Gated bounded text patches, independent verification, human acceptance/application
   with base/hash conflict checks. Direct-API patch output remains explicitly disabled.
4. Complete per-request capability/input/output/deadline budgets and user billing
   policy beyond the current conservative source/output bounds and cost coefficient.
5. Portable cross-harness handoff, approved memory and optional Jev advice in the
   later planned phases; no hidden semantic-advice requests in the strict slice.
6. Native cancellation/process-tree/exit/restart fault scenarios on each supported
   OS, and visual comparison against v0.6 using hosted screenshots. Pure lifecycle
   tests do not replace native side-effect or visual evidence. Windows has a typed
   kill-on-close Job Object with accounting-based termination, but immediate
   post-spawn attachment cannot capture a descendant created before assignment;
   creation-time assignment/suspended launch remains a containment boundary.
   Unix process groups also do not constitute an OS sandbox for escaping workers.
7. Explicit reconciliation UX for unknown old workers. Restart does not auto-replay
   them or infer process death from stale PIDs.

Keep this list visible when reporting phase results. A successful build, unit run,
smaller file, authored QA case or standalone harness receipt cannot close these
acceptance gaps.
