# Repository Guidelines

## Project Structure & Module Organization

Taomni is a cross-platform desktop workspace built with Tauri 2, React 19, TypeScript, and Rust.

- `src/`: frontend; feature UI in `components/`, state in `stores/`, IPC/utilities in `lib/`, and browser mocks in `stubs/`.
- `src-tauri/src/`: Rust backend; integration tests in `src-tauri/tests/`, bundled assets in `src-tauri/resources/` and `src-tauri/icons/`.
- `qa-ui-auto-tests/`: browser/native automation and YAML cases. `docs-feature/` and `docs-issue/` hold designs.

## Build, Test, and Development Commands

Use pnpm 10 and Node.js 22 to match CI. Native builds require Rust 1.94+, `protoc`, a complete Perl distribution, and Tauri system dependencies; see `README.md`.

- `pnpm install`: install frontend dependencies.
- `pnpm dev`: browser preview at `http://localhost:5000`, using Tauri stubs.
- `pnpm tauri dev`: full desktop development app.
- `pnpm build`: TypeScript checks and production frontend output in `dist/`.
- `pnpm tauri build`: build and package the desktop app.
- `pnpm test`: run Vitest.
- From `src-tauri/`, run `cargo test --lib` for backend unit tests or `cargo test --test integration` for integration tests.

## Coding Style & Naming Conventions

Follow nearby code: TypeScript uses two-space indentation, double quotes, and semicolons. Use PascalCase for React components, camelCase for functions/variables, and `use...` for hooks. Keep TypeScript strict checks passing.

Rust uses snake_case modules/functions and rustfmt's four-space indentation with edition 2024. Check formatting with `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`.

## Source File Size & Responsibility Boundaries

- Keep hand-maintained source files focused on one responsibility. Aim for 200–500 physical lines per file, including comments and blank lines; review the boundaries once a file exceeds 500 lines.
- New files and modules extracted during refactoring must stay within 800 lines. Split larger implementations before committing, using feature, state ownership, lifecycle, protocol, or platform boundaries. Keep UI shells limited to composing views and connecting feature owners.
- Existing files above 800 lines are refactoring debt: do not add unrelated responsibilities or increase their size. When changing their behavior, extract the affected responsibility with its state, effects, cancellation, and cleanup; do not just move a large component into another oversized controller.
- Use explicit, typed module inputs and outputs. Preserve public APIs, IPC/event names, persistence formats, asynchronous ownership, stale-result guards, and failure/retry semantics. Avoid circular dependencies and imports from an implementation module back into its shell or facade.
- Keep tests focused by behavior/scenario and share fixtures through dedicated harness modules. Move large Rust inline test suites into test modules when they obscure production responsibilities. Do not reduce line counts by compressing formatting, deleting assertions, or hiding code in generated strings.
- Generated bindings, protocol schemas, locale dictionaries, and indivisible fixtures may exceed the limit. Other exceptions need a concrete technical reason and an explicit follow-up boundary recorded in the relevant design or refactoring document; file size alone is not a reason to split generated or homogeneous declarative data.
- For each split, run the affected behavior tests and required boundary/contract checks. Verify native side effects in native tests; a successful build or a smaller line count does not establish behavioral equivalence.
- Run `pnpm check:refactor` before committing. It checks compatibility, dependency boundaries, and the 800-line limit for product sources, tests, fixtures, and build scripts; `pnpm build` runs the same checks. Keep any generated/declarative exceptions explicit in `scripts/source-file-size.mjs` and explain them in the refactoring document.

## External Network Access & Downloads

Apply these requirements when adding or changing features that access external networks, including downloads, API requests, and update checks.

- Provide three proxy modes: use the application proxy configured in Settings (default), use an independently persisted feature-specific proxy, or use no proxy. Reuse the Settings proxy configuration UI and shared backend proxy resolution; feature-specific settings must not overwrite application settings.
- No proxy must bypass implicit system/environment proxies. Surface configured proxy failures instead of silently falling back to a direct connection.
- Downloads must display their state and progress: connecting, downloading, verifying where applicable, completed, cancelled, or failed. Show downloaded bytes, total size, and percentage when available; use an indeterminate indicator when the total is unknown, and expose actionable errors.
- Support explicit cancellation, resumable downloads, and background downloading. Closing a dialog or leaving its view must not cancel a task; reopening must restore the current task state and progress. Keep task ownership independent of UI component lifetime and prevent duplicate downloads of the same artifact.
- Cancellation must stop network activity and retain safe partial data for resuming. Discover reusable partial downloads after retries or application restarts. Validate HTTP Range/Content-Range responses; if the server cannot resume, safely restart with clear feedback rather than append a full response to partial data.
- Verify available checksums/integrity before publishing the completed file. Failed or cancelled downloads must not replace a working artifact; keep partial files distinct from completed files.
- Verify proxy modes, progress restoration, cancellation, resume, and failure handling with focused tests appropriate to the change. Browser stubs alone do not validate native networking behavior.

## Testing Guidelines

Frontend tests use Vitest, jsdom, and Testing Library. Colocate `*.test.ts` or `*.test.tsx` with source; run focused tests with `pnpm exec vitest run src/path/example.test.ts`. Do not put `--` before file filters: Vitest treats subsequent arguments as passthrough and can run the full suite. Rust unit tests live in `#[cfg(test)]` modules.

Cover changed behavior and regressions; Vitest has no configured numeric coverage threshold. UI cases use `TC-XXX-<slug>.testcase.yaml`; follow `qa-ui-auto-tests/README.md` for browser/native runs. Verify native behavior in the desktop app because browser tests use stubs. Live SSH tests require environment credentials and explicit opt-in; see `src-tauri/tests/README.md`.

Every new feature, UI refactor and component upgrade must also run the complete `crash-regression` tagged browser/native suite before review, using a matching QA release binary for native. Run affected feature cases in addition to this suite. Keep a regression for every user-reported crash, reproduce it before the fix where possible, and assert actual pane/content/lifecycle results as well as `assert_no_runtime_errors`. See `qa-ui-auto-tests/ci/crash-regressions.md`. The platforms workflow automatically includes this suite on product PRs and focused hosted runs; failed or missing crash evidence blocks completion.

## Commit & Pull Request Guidelines

Follow the history's Conventional Commit pattern: `fix(screenshot): repair capture controls`, `feat(filebrowser): add folder suggestions`, or `test(rdp): verify viewport`. Keep commits focused.

PRs should explain the problem and resulting behavior, link relevant issues/designs, list validation commands and platforms, and include screenshots for UI changes. Resolve applicable CI failures before merging.
