# Evidence Policy

The task card defines `acceptance` and `required_evidence`. Both are completion gates. Evidence describes commands and observations that actually ran against the current production path; it is not a prose completion claim.

Select sufficient checks with [efficient-verification](../../qa-ui-auto/references/efficient-verification.md). Evidence kinds are proof categories, not a requirement to launch separate suites: one qualifying run can support several kinds/ACs when their assertions and shared receipt are identified. Do not repeat a current passing run simply to produce another kind. A selected case set must still cover all mandatory ACs and relevant regressions.

Review target acceptance and affected retained behavior separately using [regression protection](../../qa-ui-auto/references/regression-protection.md). Link pre-change observations as baseline context, not as current-source passing checks. Record pre-existing failures and unknown baselines explicitly. Board/receipt validation cannot discover omitted consumers or justify ignoring a known regression introduced by this task.

Ordinary `compare_idea.py` exit 0 validates record structure and may report `incomparable`/`unverified`. Tasks claiming a measured match require `--require-match`, actual target-version observations, and separate visual/interaction review where required. Preserve historical scoped waivers as exceptions with their original ceiling; do not extend them or rewrite them as equality.

## Evidence JSON

Supply one object with chronological checks:

```json
{
  "verified_at": "2026-08-30T08:30:00Z",
  "head": "<Git HEAD used as the verification base>",
  "checks": [
    {
      "kind": "unit",
      "command": "pnpm test -- src/example.test.ts",
      "result": "failed",
      "summary": "1 failed: stale response still committed",
      "acceptance": []
    },
    {
      "kind": "unit",
      "command": "pnpm test -- src/example.test.ts",
      "result": "passed",
      "summary": "8/8 passed after the production guard was added",
      "acceptance": ["ED-EXAMPLE-001-A1", "ED-EXAMPLE-001-A2"]
    },
    {
      "kind": "build",
      "command": "pnpm build",
      "result": "passed",
      "summary": "exit 0",
      "acceptance": []
    }
  ],
  "unrun": [],
  "notes": ["Checks ran on the working tree rooted at the recorded HEAD"]
}
```

Rules enforced by `task_board.py`:

- `verified_at`, `head`, `checks`, `unrun`, and `notes` are required.
- `kind` is one of the board's allowed evidence kinds; `result` is `passed` or `failed`.
- Every check has an exact command/inspection label, concise result summary, and an `acceptance` list.
- Use the task card's full acceptance IDs. Unknown or duplicate IDs are invalid.
- Checks stay chronological. For every required kind, its final recorded result must be `passed`.
- The union of acceptance IDs on passed checks must cover every acceptance ID on the card.
- A broad gate such as `build` may have an empty acceptance list and still satisfy its evidence kind.
- Put unavailable checks in `unrun` as concise strings naming the kind and reason. An unrun required kind prevents `done`.
- Keep the first failing check before the green rerun. Do not replace the failure with a summary that implies it never occurred.

## What Each Kind Proves

| Kind | Minimum qualifying evidence |
|---|---|
| `code-audit` | Names the production entry and owner, then traces provider/effect, stale/cancel/failure, undo/recovery, and observation. Import/export existence alone fails. |
| `unit` | Exact command, exit/result, and test count or named assertions. Mock-only tests prove only their modeled boundary. |
| `typecheck` | `typecheck_scope.py` (or an equivalent recorded command) over the paths this card owns, exit 0, with the owned-path list and the out-of-scope error count both recorded. Zero errors in the card's own paths is the gate; another card's red module is reported, not inherited. |
| `build` | Exact repo-wide build command and exit 0 for the current task tree. Reserved for the gate and release cards that own the shared gate; a feature card uses `typecheck`. |
| `rust` | Exact focused Rust command and result; use only real Rust/IPC coverage. |
| `qa-lint` | QA catalog/lint/audit command and its counts. A clean lint does not prove behavior. |
| `browser` | Mounted or E2E assertions for observable entry, effect/result, negative path, and undo/recovery where required. Visibility and screenshots alone fail. |
| `native` | Packaged/Tauri runtime crossing the real OS boundary, with platform/runtime/fixture and postcondition recorded. |
| `provider` | Real provider id/version, JDK/tooling, fixture, request/result/cancel facts, and postcondition. Hand-built provider responses fail. |
| `performance` | Environment, fixture, warmup, sample count, percentile method, budget/result, and raw artifact location. |
| `accessibility` | Separate keyboard, focus, name/role/state, zoom, screen-reader, and IME observations as applicable. |
| `idea-comparison` | IDEA version, identical fixture/action, observed behavior/delta, and the accepted claim ceiling. |
| `document` | Current document/ADR content is reviewed against named acceptance IDs and linked authoritative sources. |

## Non-Qualifying Substitutes

Do not use any of these to satisfy a stronger layer:

- synthetic PASS records, model-only tests, manually constructed signed receipts, or hard-coded timings;
- screenshots without behavioral assertions;
- browser VFS/Tauri stubs for native disk, clipboard, IME, or packaged-runtime behavior;
- fake LSP responses for provider completeness or refactor safety;
- QA observation hooks that inject state or execute the action they claim to observe;
- a passing rerun that omits a still-failing card-specific path;
- an old commit's evidence without re-running it against the current production path;
- a `typecheck` scope narrowed to dodge the card's own red files, or one that silences an error by deleting the assertion, widening a closed union, or weakening a type the production path actually depends on. Scope names what the card owns; it never shrinks to fit what currently compiles.

If a required layer cannot run, use `implemented` when the production outcome is complete or `blocked` when an external prerequisite prevents further work. Never encode `not run` as `passed`.
