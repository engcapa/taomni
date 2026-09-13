# Efficient Verification For All Taomni Features

## Select Before Setup

Put a compact selection in the task/design or handoff: each relevant AC, its
assertion, cheapest sufficient layer, case/test and why any expensive boundary
is necessary. Separate iteration, completion and integration/release. This is
not an extra approval or mandatory separate planning document. The selected set
includes both the intended change and affected behavior that must remain.
For shared behavior/UI refactors, use [regression-protection.md](regression-protection.md)
to establish relevant baselines and consumer checks before narrowing cases.

| Change | Iterate | Complete / escalate |
|---|---|---|
| Skill prose / docs | Read/link/frontmatter checks | No app build or UI suite |
| Planner / evidence utility | Focused Python contracts + CLI smoke | Native sample only if execution behavior needs one |
| Logic / store / state machine | Exact tests; one discriminating red→green bug regression | Relevant consumer tests; native for OS effects |
| CSS / layout / labels | Actual browser render and affected states | Focused current-WebView smoke, no unrelated provider suite |
| Menu / focus / shortcut / lifecycle | Mounted/StrictMode + browser interaction | Actual affected keyboard/focus/IME path and frontend mode |
| IPC / filesystem / PTY / provider / recovery | Narrow logic/Rust/integration | Native boundary with result, negative/recovery assertions |
| Hot path / large data | Distinguishing baseline + focused regression | Matched native measurement of that path |
| Shared UI / cross-module refactor | Changed primitive and representative consumers | Expand to affected consumers, not automatically every feature |

The completion column describes desktop app delivery. An explicit browser-only
request or a skill/tool evaluation can finish at its stated layer, with packaged
WebView/OS behavior unverified. Do not compile or require an unlocked desktop just
to verify a planner change or a browser workflow. This does not waive native
acceptance already required by an actual product task.

UI/interaction may be rebuilt. Rewrite assertions for deliberately replaced
flows against the new target, retain assertions for preserved behavior, and
record old/new ACs. Do not remove failures merely to get a pass.

## Cost Mechanisms Found In This Repository

These are code-backed mechanisms, not measurements of every machine:

- `typecheck_scope.py` runs repository `tsc -b`; scope filters diagnostics, not
  compilation. `pnpm build` also runs it. Check the union of owned paths once on
  stable input, not once per file. A successful build on identical input can
  supply its complete unedited log via `--from-file <log> --exit-code <recorded-code>`
  with known command and source identity. The helper resolves platform launchers
  and rejects process/global compiler failures (exit 2); scoped errors return 1.
  Log import still cannot establish freshness or authenticate its supplied exit.
- `native_build.py` invokes `pnpm tauri build --no-bundle` and the frontend hook.
  Source changes invalidate the embedded frontend even with unchanged Rust logic.
  Preserve its incremental target and input-verified reuse. No routine `cargo
  clean`, `--force`, fresh target directories or rebuild per case. Avoid an
  identical standalone `pnpm build` just before native build; its successful
  frontend hook log may satisfy the required build contract.
- Build fingerprints conservatively include source paths, including colocated
  tests, plus frontend mode. Finish related source/test edits before final build.
  Do not shrink fingerprints or update identity files to manufacture cache hits;
  narrower build dependencies need evidence and invalidation tests.
- Native cases start independent sessions/fixtures; Java import/provider startup
  can repeat. Submit selected IDs in one invocation to share the driver, keeping
  mutable app/DB/project/provider state isolated. New coherent workflow cases can
  assert related outcomes after one setup; independent scenarios stay isolated.
- Shared/unmapped code or coarse feature ownership can recommend many cases.
  Treat `plan` as discovery, then select exact `--case`/feature scope after
  tracing consumers, including affected retained behavior in other features.
  Explain omitted plausible candidates. QA prose-only changes
  no longer broaden product selection.
- Full suites after every edit, global status gates per feature, unconditional
  release audits and repeated control generation add workflow overhead.
  A large mounted test file may still take a minute even with no native build.
  During iteration, select relevant names with `pnpm exec vitest run <file> -t
  '<target|retained behaviors>'`; inspect selected/skipped counts. Keep a bounded
  dedicated test module when a responsibility can be mounted independently, plus
  representative shell integration tests. Do not mistake unselected tests for
  environment skips or claim that the full file passed.

Without raw timings, the relative contribution is unknown. Use the task's
existing reports/build log; do not run a full suite just to measure test cost.

## Native Compilation Policy

Default: fast iteration → stable related code/tests → one QA build per required
configuration → selected native scenarios. Native-only defects can need an early
baseline probe; record that purpose. Do not postpone platform feasibility until
after an expensive implementation.

`python .agents/skills/qa-ui-auto/scripts/native_build.py --check` does not compile
or launch. Inspect changed input categories. Exit 1 means build when native
validation is due, not stop planning/fast tests. Prior build duration is
historical; a cache hit does not incur it again. Normal build rechecks inputs.

Batch native checks on stable inputs and group frontend/build modes to avoid
production↔development rebuild thrashing. Rust debug is not React development.
`NODE_ENV=development` exercises StrictMode; real Vite/HMR needs a separately
verified QA dev setup. The current packaged harness does not automatically bind
a live dev frontend's identity. An old embedded frontend cannot prove current UI.

Browser preview and real service bridges can prove their actual paths while
native compilation is deferred. Label these boundaries. A future lighter native
dev harness is allowed, but must bind served frontend/backend identity, isolation
and result evidence before replacing this workflow.

## Diagnose Time

`python -m qa_ui_auto costs --reports <task-report-dir> [--case <exact-id>]` reads
existing summaries recursively inside the chosen root. Prefer a task directory
or explicit summaries. Failures, skips and repeated attempts remain in cost totals.

| Observation | Action |
|---|---|
| Build dominates | Reuse matching binary, defer candidate build until stable, inspect invalidation, preserve incremental target |
| Fixture/session dominates | Select fewer redundant cases; prepare needed fixtures; combine coherent assertions when authoring |
| Fixed `wait` dominates | Use observable readiness where supported; retain time-based waits required by the behavior |
| Assertion polling dominates | Inspect readiness/selector/provider and failure artifacts; separate app delay from harness error |
| Cleanup dominates | Inspect owned process shutdown; keep host restoration and failure capture |
| Repeated failures dominate | Diagnose before retry; use a smaller reproducer or another truthful layer |

Case sums are worker occupancy, not wall time. Phase/step times are nested, not
additional. Summaries omit build time and may miss partial setup timing after
failure. Missing is unknown. `costs` validates neither receipt/freshness nor app
latency; check `status` separately before claiming current coverage.

## Stop Repeating Satisfied Checks

After the last change, inspect which results still match source, case, runner,
config and build. Reuse valid executions for multiple ACs/kinds. Global QA
identity may invalidate older results after unrelated changes; choose a
sufficient fresh slice, never relabel stale receipts as current.

Preserve a failing run, fix/diagnose, rerun affected checks. Broaden only for new
shared-risk evidence. Repeated identical environment failure warrants a different
diagnostic approach, not full-suite loops or dropped requirements.

Existing explicit gates remain binding unless an authorized scope change calls
for a documented contract revision. New tasks must not copy all historical kinds.
A native run can cover UI, provider and disk outcomes together. Build once after
related edits, and stop when sufficient checks and required current-platform
verification pass. Report build/reuse count and costs without theoretical speedup
claims. Skill-only work does not automatically require an app build.
