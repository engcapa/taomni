---
name: code-workspace-idea-task
description: Claim and deliver one small Taomni Code Workspace IDEA parity task, or author its backlog and linked specifications when explicitly requested. Verify acceptance and current evidence against production code. Do not use the historical design document as a queue or for unrelated Code Workspace work.
---

# Code Workspace IDEA Task

Deliver one `ED-*` task from the caller-selected backlog. Use the board/ID passed by the user or `code-workspace-idea-parity`; without one, resolve the requested capability against linked current work before claiming. There is no permanently current dated board. Pass its exact path through `--doc` on every command; never rely on the script's legacy default or reclaim done tasks. A historical green task, exported model, fixture-only path, screenshot or unrun check is not current completion evidence.

When asked to create/review a backlog or its designs, or handed a planning stage within an authorized development workflow, use [references/backlog-authoring.md](references/backlog-authoring.md). Planning alone does not claim or implement a product card. The one-claimed-task lifecycle below applies to execution. Requests to maintain these skills do not trigger a product audit or task board mutation.

## Read The Contract

Before claiming:

1. Read the repository `AGENTS.md`.
2. Read backlog sections 1-3, the selected card, and its dependency cards.
3. Read the selected card's linked spec and applicable shared contracts, including `claudedocs/code-workspace-idea-specs/shared-contracts.md` where inherited. The selected board defines its build-gate owner and platform scope. For UI/interaction alignment, read the linked IDEA reference and target states, not all historical capability designs.
4. Read [references/task-lifecycle.md](references/task-lifecycle.md) before using the task-board script.

Read `claudedocs/code-workspace-ide-design.md` only when a card's `legacy` links or an implementation question needs historical detail. Its old queues are archives, never claim sources.

Before verification or a terminal status update, read [references/evidence-policy.md](references/evidence-policy.md).

## Non-Negotiable Boundaries

- Work on exactly one claimed task. Do not absorb unrelated work; regressions introduced by this task in adjacent features are this task's responsibility.
- Claim only `ready` or `implemented` when all dependencies are `done`. Never manually edit ownership metadata.
- Re-audit current production code after claiming. The backlog records a dated baseline, not an assumption that the gap is unchanged.
- Satisfy the selected spec, every listed acceptance ID, and every required evidence kind. Do not weaken the spec or tests to fit existing code.
- Trace a real chain: user entry -> production owner -> provider/IPC -> typed result/effect -> failure/cancel/stale -> undo/recovery -> observable evidence.
- Preserve unrelated worktree changes. Keep edits within the card's outcome and ownership boundary.
- Do not collapse `failed`, `cancelled`, `stale`, `conflict`, or unknown external effects into generic success/unavailable states.
- Browser stubs cannot prove native filesystem, clipboard, IME, provider, performance, accessibility, or IDEA behavior.
- A task is `done` only when structured evidence covers all acceptance IDs, every required evidence kind has a final passing check, and affected retained behavior has been verified with no unresolved regression introduced by this task.

## Implement And Verify

If current code already satisfies the card, verify its production path rather than reimplementing it. Current UI/layout/interaction is not a preservation requirement: refactor components, menus, focus flows or layout as needed for the authorized IDEA target. Preserve retained functional/data contracts and coordinate shared consumers. When old UI restrictions conflict with newer user authorization, record the concrete spec revision within that authority. Only genuinely unresolved material target/contract decisions require `review_required`; do not request permission again just because refactoring is necessary.

For a bug fix, add a focused regression that fails for the intended reason on the baseline. New behavior needs meaningful observable coverage; cosmetic or documentation changes need appropriate inspection, not artificial failing tests. Refactor even large components when the target warrants it, with explicit ownership and regression scope; avoid unrelated rewrites.

Before behavior refactors, read [regression protection](../qa-ui-auto/references/regression-protection.md). Identify intended changes and retained user outcomes, trace shared consumers, and establish the relevant pre-change baseline. Protect normal paths as well as the target fix; a newly passing target test cannot replace previously passing behavior checks. Verify risky cutovers with focused checks and the final combined code with affected consumer scenarios. Review removed/weakened tests against authorized expectation changes.

Read [efficient verification](../qa-ui-auto/references/efficient-verification.md) and select iteration/completion checks by affected ACs. Iterate with exact test files/name filters and browser feedback; after related code/tests stabilize, run one typecheck over all owned paths and batch required native checks on a verified QA build. `typecheck_scope.py --path <owned path>` still compiles repository TypeScript: combine repeated `--path` values, do not invoke per file. Reuse a complete successful same-input build log with known exit/source identity when it satisfies typecheck. The board's build owner handles full build/integration; relevant Rust changes get focused Rust tests. Do not run every historical case or release gate for a local card.

Use the repository `qa-ui-auto` skill for UI workflows, testcase/catalog changes, or evidence surfaces. Follow its current entrypoints and references: select `run --mode browser` or `native` explicitly, read `summary.json` with its matching receipt and source/case/runner identities, and inspect selected/pass/fail/skip counts. `audit --gate` is static coverage; `status --gate` is reviewed current execution in an explicitly selected scope/platform; `audit --release-evidence` validates the existing release manifest. Dry-run and exit 0 alone prove no behavior. Read native-testing before native launches, authoring/verb-catalog before case edits, and verification before interpreting coverage/performance. Manual IDEA/macOS evidence stays separate from runner-generated passes. Run native/provider/performance/accessibility/IDEA layers only in qualifying environments; record unavailable layers without fabricating substitutes.

Before updating the board, review the final diff and re-check every acceptance ID against the actual production path. Preserve failed checks before successful reruns in chronological evidence.

A single native/provider/UI execution may cover several kinds/ACs with separate assertions; link it once instead of rebuilding or re-running per kind. For visible changes, use [visual/interaction comparison](../qa-ui-auto/references/idea-visual-interaction.md). Ordinary comparison-validator success is not a measured IDEA match. Stop testing when the sufficient required checks pass; expand only for new changes, failures or unresolved requirements.

## Finish One Task

End in one truthful state:

- `done`: target acceptance, required evidence and affected retained-behavior checks passed; no known task-induced regression remains.
- `implemented`: production work is complete, but named required evidence is missing or currently failing. A confirmed task-induced product regression means implementation still needs repair; do not relabel it as only missing evidence.
- `review_required`: implementation and spec have a material contract conflict requiring maintainer review.
- `blocked`: a reproducible external prerequisite prevents further progress; record the condition needed to resume.

Validate the board after the update. If the caller requested one commit per task, stage only this task's implementation, tests, necessary spec changes, and backlog update, then create one conventional commit containing the task ID. Never include unrelated user/agent changes.

Report the task ID, baseline and final worktree/commit state, files changed, production effect chain, commands and results, unrun layers, terminal status, and the narrow capability ceiling. Do not claim broader IDEA parity than the evidence proves.
