# Authoring And Maintaining Coverage

Reuse audit results and source context. Inspect the owning feature in
`qa-ui-auto-tests/feature-list.md` and its source files; run a helper only when
information is missing. Apply requested changes directly and summarize the diff.

## Design To Implementation Handoff

When planning and implementation are separate (such as IDEA parity P1/P2),
keep the complete test design in the card's linked spec/design under a stable
`test-cases` anchor. Reuse an existing detailed verification section instead of
duplicating it. For IDEA parity this is normally the selected design in
`docs-feature/code-workspace-idea-parity/`; a bug design may live in `docs-issue/`.
The backlog and handoff link to the exact file/anchor. Chat, an AC title, a test
command or a list of V IDs alone is not a complete test case.

| Artifact | Repository location and responsibility |
|---|---|
| Case design and AC/V mapping | P1 writes the linked design section; P2 maintains its mapping to actual tests and results |
| Executable UI workflow | P2 creates/updates `qa-ui-auto-tests/cases/TC-<id>-<slug>.testcase.yaml`, reusing existing IDs/cases when sufficient |
| Feature ownership and controls | P2 maintains `qa-ui-auto-tests/feature-list.md` and YAML `covers` together; regenerate this skill's `references/testid-catalog.md` only when controls change |
| Focused unit/component/backend regression | P2 uses colocated `src/**/*.test.ts` / `*.test.tsx`, Rust inline tests, or the unified `src-tauri/tests/integration/` suite as appropriate |
| Native/manual checks unsupported by the runner | P1 specifies reproducible steps and observations in the design or links an applicable `qa-ui-auto-tests/native/` runbook; P2 records actual execution separately |
| Runtime evidence | P2 retains reports, receipts, logs, screenshots and recordings under `qa-ui-auto-report/` (uncommitted); the design/handoff records precise paths and evidence identities |

For each selected case, specify:

- Stable V ID, associated ACs, target versus retained behavior, and existing or
  proposed test path plus exact YAML ID/test name. Check IDs against the current
  repository; a proposed ID is not registered or executable yet.
- Preconditions, initial state, fixture data/content and isolated setup/cleanup;
  real services/provider requirements and readiness checks when relevant.
- Ordered user actions and observable expected results at decisive steps,
  including final UI state and relevant disk/provider effects. Cover applicable
  normal, boundary, failure, cancel/stale, recovery and shared-consumer paths;
  explain material exclusions rather than adding irrelevant permutations.
- Layer, browser/native mode, supported OS/WebView, selectors/controls and verbs
  already available versus additions assigned to P2. Identify stub/mock limits.
  For IDEA comparison include matched reference states and visual/interaction
  observations; functional assertions alone do not prove visual parity.
- A checked command/config or manual procedure, expected evidence, baseline
  source or pending baseline check, implementation owner and execution status.
  Mark future files/commands as planned and all unexecuted checks as unrun.

P1 completes this design and the mapping before declaring planning ready; it does
not edit product tests or run the app when its permission is documentation-only.
Missing implementation, fixtures or verbs can be assigned explicitly to P2;
missing expected behavior or an undecided acceptance result cannot be hidden by
marking the card ready. P1 need not create draft YAML in the runner's case tree.

P2 checks the mapping against current source, implements the selected tests and
any necessary fixture/control support, and runs the target plus affected retained
behavior checks. Reuse sufficient tests; do not add artificial unit tests for
prose or cosmetic changes. Read the schema and relevant verb-catalog entries
before writing YAML. For unsupported automation, assign fixture/verb support or
explicit manual checks at the required layer; use native only for native boundaries.
Never invent verbs or use a skip as proof. Follow the catalog/audit rules
below when cases or controls change; prose-only handoff edits need no product audit.
Record AC -> V -> actual test/case -> report/assertion, with pass/fail/skip/unrun
and platform boundaries. Static validation and dry-run cannot fill runtime results.

## Coverage Dimensions And Mode Selection

Use browser first for every assertion it can establish through the production
renderer. Default new UI cases to `modes: [browser]`. Add native only for a named
assertion that requires real Tauri IPC, disk/process effects, native dialogs or
clipboard, OS shortcut interception, IME, window lifecycle, or a concrete
WebView/packaging difference. State why browser evidence is insufficient.
App-local shortcuts, focus and Actions are not inherently native. A missing
browser verb is an automation gap to assess, not evidence of a native boundary.
Do not bulk-convert existing modes or relax explicit native acceptance.

P1 records the following applicable dimensions in the linked case design; P2
checks each against actual tests and results. Use rows such as
`AC/V | dimension | control/Action/shortcut + context | steps/expected result |
case/test | mode + native reason if needed | result/evidence or gap`.

| Dimension | Assertions within the changed and affected retained behavior |
|---|---|
| UI | Layout/overflow, labels/icons, visible/hidden, enabled/disabled/selected, loading/empty/error states; matched screenshots or geometry where visual fidelity is an AC |
| Controls and interaction | Operate each affected button/menu/context-menu/list/tab/dialog/input and applicable click/double-click/right-click/drag/scroll/text input; assert opening/closing, selection, focus transfer/return, validation, submit/cancel and resulting state |
| Actions | Exercise each affected exposed entry (toolbar/menu/context menu/command palette as present), checking availability, context/selection, dispatch target, side effect and disabled/no-op behavior; a direct handler call cannot prove UI wiring |
| Shortcuts | Press actual key combinations in relevant focus/keymap contexts; verify routing, modifiers, conflicts, editable-field protection, disabled contexts, repeated invocation and no duplicate dispatch where relevant; a menu click cannot prove a shortcut |
| Lifecycle and regression | Normal/boundary/negative paths, failure/cancel/stale/retry, undo/redo/save/reopen where applicable, consecutive operations and affected shared consumers |

Account for all affected controls, exposed Action entries and shortcut bindings,
including those outside the owning feature. Avoid an arbitrary Cartesian product;
combine equivalent setup and repeated result checks, but keep assertions for each
distinct entry/routing/state transition. Mark a dimension N/A only with a concrete
reason; unsupported or unexecuted behavior is a gap, not N/A or pass. Controls
touch coverage, one happy path or a smoke case cannot establish completeness.
Browser and focused native checks may jointly satisfy the matrix without repeating
the entire browser suite in native. Never replace a required native effect with
a stubbed pass, or claim native fidelity from browser results.

## Cases

- One unique ID per `cases/<id>-<slug>.testcase.yaml`; drafts may use `cases/auto/`.
  Set `covers: [F.x]` and `fixtures` explicitly. Use `reset_db` for persistent
  mutations, plus required network/workspace/provider fixtures.
  For a new fixture, implement it in `scripts/qa_ui_auto/fixtures/`, add it to
  that package's `REGISTRY`, and add its name to `schema/testcase.schema.json`.
  Prefer a small dependency-free fixture for tree/editing checks; don't import a
  Java project unless a provider is part of the assertion. Keep retained files
  under the run report root and state the browser/native visibility boundary.
- Assert the user's result after acting, including relevant failure/recovery
  paths. Control touches alone do not prove workflows work. Use browser for
  renderer behavior and selected native cases for real OS/IPC boundaries.
- Set `modes` explicitly, preferring `[browser]`. Use `[native]` for required
  real-app boundary workflows; use `[browser, native]` only when both modes are
  needed and their implementations/fixtures support the assertions.
  Browser-specific stubs/verbs stay `[browser]`. Missing modes still default to
  browser for compatibility. Never mass-add native without checking verbs/fixtures.
- Native is a mode, not an OS guarantee. Some verbs are Linux/X11-only; check
  [verb-catalog.md](verb-catalog.md) and `scripts/qa_ui_auto/native_steps.py`.
  Use platform runbooks for OS differences and disclose unsupported paths.
  `native_platforms: [Linux, Windows]` optionally restricts native execution;
  it does not certify those platforms. Do not substitute mocks for OS evidence.
- Each step is a single-key map using a schema-supported verb. `eval_readonly`
  is the only raw-JS escape hatch; never mutate state or bypass the real action.
  Its schema uses conservative text checks, not a JavaScript parser (even an `=`
  inside a selector string can be rejected). Prefer dedicated attribute/count/text
  assertions and short observation expressions; do not obfuscate writes to evade it.
- Prefer exact `[data-testid="..."]` selectors from feature controls or
  [testid-catalog.md](testid-catalog.md). Add stable testids where needed; avoid
  styling classes and fragile text. Do not add expensive production polling,
  DOM mirroring or instrumentation solely to make automation easier.
- Use condition-based waits and existing performance budgets. Measure affected
  native interactions as described in [native-testing.md](native-testing.md).
  Never weaken assertions, increase latency budgets or skip regressions to pass.

Tags: `smoke` for fast (normally <=30s), self-contained cases; `p0` for release
critical cases; `p1` for broader coverage; area tags for selection. Mark drafts
`auto-generated, needs-review`, adding `smoke` only when appropriate. Retain
`needs-review` and `legacy-imported` until assertions have been reviewed.

## Repair And Verify

Read failure artifacts, YAML and current source to distinguish stale tests from
product regressions. Fix within the user's requested scope; diagnosis alone does
not authorize unrelated product changes. Run affected IDs after a concrete
correction, retaining first-failure evidence and disclosing skips.

The runner validates YAML, so normal edits need a targeted run rather than
separate lint/dry-run/run stages. Use native dry-run before a new build to check
new verbs/platform scope cheaply. For case/feature/control edits, run
`python -m qa_ui_auto audit --gate` once after the batch; regenerate the control
catalog beforehand only when controls change. The audit checks
lint, freshness and the existing coverage ratchet. Ratchet verified improvements
only; do not overwrite unrelated baseline losses.

## Catalogs And Optional Helpers

Add feature `id/title/status/area/components/files` and controls to
`qa-ui-auto-tests/feature-list.md`, then reference its ID from cases. New/unowned
changed files may extend a feature or justify a new one; private helpers do not
automatically need features. Refresh touched features for observable changes.
Remove deleted files from `files`; assess empty features before removing them.

Controls declare `id`, `selector`, `kind: interactive|display`, optional aliases
and `optional`. Conditional controls are not automatically optional: required
workflows must reach them. Review extractor drafts against source. Regenerate
`references/testid-catalog.md` after controls change.

Coverage matches exact selectors/aliases (normalizing quotes) or derivations at
CSS boundaries (`[`, space, `:`, `>`, `,`). The longest control match wins.
Interactive controls require interaction verbs; display-only touches are shallow.
Fix orphan attribution without weakening the asserted behavior.

Use `python -m qa_ui_auto.<module> --help` for flags. Existing modules remain
available for scripts and CI; this table is not a required command sequence.

| Need | Module / Arguments |
|---|---|
| Combined health, gaps, diff and gate | `audit [--feature F.x] [--diff REF] [--gate] [--json]` |
| Case/control context or extraction playbook | `fix tests F.x`, `fix tests --diff REF`, `fix controls F.x` |
| Commit-range inventory | `range_changes --since REF` or `fix features --range REF` |
| Render/check catalog | `gen_testid_catalog [--check]` or `fix catalog` |
| Ratchet verified coverage | `control_coverage --update-baseline qa-ui-auto-tests/coverage-baseline.json` |
| Detailed coverage / orphans | `coverage_report --controls`, `control_coverage --orphans` |
| Strict schema / orphan diagnostics | `lint --strict-orphans` |
| One feature's metadata | `feature_catalog --feature F.x --json` |
| Extract controls / initial bulk fill | `control_extractor FILE.tsx`, `batch_extract` |
| Explicit changed-file impact | `diff_impact --files A.tsx B.tsx` |

When adding a verb, update implementation, testcase schema and verb catalog
together; check/implement native support where appropriate. Validate the argument
contract and execute a representative case. Evidence rollup, release-plan and
artifact scripts remain available when their existing contracts are needed;
routine case maintenance does not require them.

## Executable behavior contracts

Use `verification` to map requirements to 1-based YAML step indices. Each requirement
has `id`, `requirement`, `actions`, `checkpoints: [{step, expectation}]`, and `results`
(the decisive checkpoint indices). Set `review: pending` until semantic review
confirms the actions and assertions establish the stated requirement; generated
mappings do not constitute that review. Update indices when inserting steps.

Declare `visual` and `native` checklists separately, each entry with `check`,
`method: automated|manual|external|not-applicable`, and a concrete `reason`.
Native/manual boundaries must identify their checks or remaining gap. A screenshot
is an artifact, not a visual verdict. Browser assertions cannot certify native effects.

`python -m qa_ui_auto contracts --gate` requires reviewed, structurally valid
contracts for every selected case. The gate detects missing/out-of-range references,
non-asserting results, and results preceding actions. It does not infer complete
requirements or certify assertion strength. The run report maps each requirement
to actual step pass/fail/unrun evidence; dry-runs never produce passing checkpoints.

Use `assert_text_equals` / `assert_items` for complete deterministic content,
ordered rows and unchanged editor text. A substring assertion is appropriate for
one necessary message within variable output, but not a claim that the entire
content is unchanged. Terminal command echo cannot prove execution: assert a
separate anchored output line, and check repetition counts when proving replay.
