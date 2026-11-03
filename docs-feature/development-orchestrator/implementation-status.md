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

Native API fixtures exercise real IPC/network/disk boundaries; browser versions
exercise the production renderer against explicit stubs. The standalone six-worker
canary is supporting protocol/CLI evidence only. It cannot replace the native UI
case. The worker lane is loopback-network-isolated and uses the same verified
release build producer as ordinary native cases. Other native services and the
complete mandatory `crash-regression` suite remain in their ordinary lanes.

### Local checks actually executed

No local product browser/native case, live fixture endpoint or real worker was run.

- Node **22.23.4**, pnpm **10.33.0**: 111 focused Vitest tests passed across nine
  UI/store/navigation/safe-exit files; `tsc -b` passed.
- `cargo test --lib orchestration:: --no-default-features --features voice-capture
  -j 2`: **30 passed**, none failed/ignored. Includes context/manifest/framing,
  store/settings, capacity, cancel-before-spawn, unknown ownership and atomic finish.
- Same unit feature configuration: `llm::invocation` **36 passed**;
  `go_compatibility_tests` **22 passed**. A final combined root-unit run of
  `llm::invocation llm::openai_compat llm::anthropic orchestration::` passed
  **88 tests**, none failed/ignored. After the final safe-exit integration change,
  the combined `orchestration:: app_exit::` run passed **33 tests**.
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

No hosted product or six-harness acceptance pass is claimed at this checkpoint.

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
