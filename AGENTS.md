# Repository Guidelines

## Project Structure & Module Organization

Taomni is a cross-platform desktop workspace built with Tauri 2, React 19, TypeScript, and Rust.

- `src/`: frontend; feature UI in `components/`, state in `stores/`, IPC/utilities in `lib/`, and browser mocks in `stubs/`.
- `src-tauri/src/`: Rust backend; integration tests in `src-tauri/tests/`, bundled assets in `src-tauri/resources/` and `src-tauri/icons/`.
- `qa-ui-auto-tests/`: browser/native automation and YAML cases. `docs-feature/` and `docs-issue/` hold designs.

## Modular Product Development

Taomni is released as a core application plus independently versioned official
modules. Keep module implementation in `src-tauri/plugins/<slug>/` and keep
shared protocol or platform-neutral code in `src-tauri/crates/`. A module must
provide `module.json`, its native host when required, its frontend entry, data
and backup ownership declarations, migration declarations, and its registry
integration. A module may depend on `taomni-plugin-api` and approved shared
crates. It must not depend on the core crate or another module.

The core owns the registry, lifecycle, permissions, profile leases, Vault
scoped services, backup coordination, and the renderer host. Installed module
code lives under `<app-data>/plugins/<slug>/versions/<version>/`, the active
version is selected by `active.json`, and module data lives under
`<app-data>/plugins/<slug>/data/`. Disabling or uninstalling a module keeps its
data until the user explicitly confirms permanent deletion.
Derived module binaries and caches staged under `<app-data>/plugins/<slug>/runtime/`
are removed with the version directories during uninstall.

Every module change updates the module manifest, browser and native cases,
feature-list and testid catalogs, migration and backup fixtures, and the
platform build and signing matrix. Core changes update the core compatibility
contract and core-only regression selection. Keep the `coreApiVersion` stable
for compatible changes and raise it only for a breaking plugin contract.

Release artifacts use two independent manifests. The core uses `latest.json`.
Modules use `.taomni-plugin` packages, detached `.minisig` signatures,
`SHA256SUMS`, and the signed `modules.json` catalog. Upload every referenced
package and signature before uploading the catalog. Publish `latest.json` only
after all core assets have passed signature verification.

Use the release workflow according to the changed ownership. A core-only
change builds and publishes new core installers and `latest.json`, then carries
forward the last verified `modules.json` and its signature without rebuilding
module packages. A module-only change builds and publishes that module for all
declared platforms, preserves the other catalog entries and the frozen
`legacyUpgrade` roster, increments the catalog sequence, and publishes the new
signed catalog and packages to a module release. It then updates the catalog
assets on the latest core release. A change that
touches both produces both asset sets in one draft release and publishes both
manifests after their respective gates pass. Module assets remain separate
GitHub Release assets and are never embedded into the core installer.

Local validation is limited to unit, contract, static, formatting, dependency
boundary, and build checks. Run browser, native, real installation, upgrade,
cross-process, signing, and system-permission validation through GitHub
workflows. Each product run includes affected cases and the complete
`crash-regression` collection. Download completed shards during execution and
record the source SHA, selection, build identity, case digest, receipt, and
summary. Existing failures may be isolated only with evidence that they are
unrelated to the current change.

The modular release gate is closed only when G1 through G11 each have a
matching-source GitHub receipt. G1 covers macOS host execution and signing,
G2 system permission ownership, G3 Windows protection, G4 Linux `noexec`, G5
frame throughput, G6 forced-exit cleanup, G7 no-restart lifecycle, G8 package
and catalog tamper rejection, G9 core-only dependency closure, G10 RPC
timeouts/cancellation/repeated requests, and G11 profile/mode leases plus
re-exec entry ownership. Unit results or a green aggregate job without the
platform-specific receipt do not close a gate. The final release record must
bind every gate to the source SHA, runner image, package identity, and raw
artifact path.

Match the OS signing policy on `main` for G1 and G3. On macOS, verify the
fixed signing identity of the core and host, retain the Gatekeeper assessment,
and exercise the installed host and system permissions. On Windows, record
Authenticode status and exercise downloaded hosts with Defender enabled.
An unsigned Windows installer and an unnotarized macOS app are accepted under
this policy. Module, catalog and updater signature verification is required.

For G5, accept input-to-frame p95 up to twice the existing 65 ms reference.
Record the 130 ms limit and the observed p95 in the modular QA evidence. Apply
the reviewed RDP case checks for first graphics, frame rate, bandwidth, and
sample completeness.

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

## UI & Interaction Standard

All desktop UI changes in the shell, core and official modules follow
[UI-STANDARD](docs-feature/ui-standard/UI-STANDARD.md) and its
[enforcement and acceptance criteria](docs-feature/ui-standard/ENFORCEMENT.md).
Apply the same rules to detached windows, overlays and standalone desktop entry points.

- Identify affected control types, rule IDs and registered exceptions before implementation.
  Document deviations in UI-STANDARD §9 and cite the applicable IDs in the design and PR.
- Reuse shared controls, theme tokens, effective platform bindings and window-local
  app dialogs. Preserve content-specific appearance and the original object of an async decision.
- Shared controls for independently packaged renderers live in
  `src-tauri/crates/taomni-plugin-api/frontend/ui/`. Pass translated labels and
  use the renderer host's React instance. Build each affected module with its
  production Vite config and include shared control and stylesheet inputs in
  the signed frontend workflow's source check.
- Verify the required interaction matrix for each affected entry, including keyboard
  completion, IME, focus return, disabled/busy/error states, both themes, font-size
  endpoints and the owning window where applicable.
- Declare `ui_standard` on changed UI cases and map each ID to requirement steps
  with observable results. Run affected unit, browser and native cases together
  with `ui-contract` and `crash-regression`. Record platform, mode, source and receipt.
- Keep the desktop UI lint baseline empty and run `pnpm check:refactor`. The
  development case check fails desktop renderer changes without a changed
  rule-mapped case.

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

## macOS UI and Shortcut Compatibility

- Design and test macOS desktop UI against its AppKit application menu, native traffic-light controls and overlay title bar. Browser preview has a renderer menu and different chrome; do not require Windows/Linux custom controls on macOS or infer native compatibility from browser screenshots.
- Follow macOS shortcut conventions for standard actions: Command for application/editing commands, `Cmd+,` for Settings, `Cmd+Q` for Quit, `Cmd+W` for closing the current document/tab (or window when appropriate), and `Cmd+Shift+Z` for Redo. Preserve system Hide/Minimize/fullscreen shortcuts. Keep Control-based terminal signals and intentional editor/keymap bindings distinct; do not mechanically replace every Ctrl with Cmd. Display macOS modifier names/symbols consistently with the actual binding.
- For changed shortcuts, specify the action, exact platform chord, focus/context, menu accelerator and visible result. Check native-menu/frontend duplicate dispatch, conflicting system shortcuts, editable-field ownership, IME composition, disabled contexts and focus restoration. Use `Mod` only for an intentional Cmd/Ctrl equivalent; use explicit `Meta`, `Control` and `Alt`/Option or `macos_key` for platform-specific behavior.
- Use `.agents/skills/qa-ui-auto/references/macos-ui-compatibility.md` and its linked native runbook for case design. WKWebView bridge `press` and AppKit menu activation do not establish OS key delivery, actual menu-bar clicking or native window control behavior. Keep those checks and untested macOS versions/architectures explicit; record existing deviations as gaps rather than changing expectations to match them.

## Commit & Pull Request Guidelines

Follow the history's Conventional Commit pattern: `fix(screenshot): repair capture controls`, `feat(filebrowser): add folder suggestions`, or `test(rdp): verify viewport`. Keep commits focused.

PRs should explain the problem and resulting behavior, link relevant issues/designs, list validation commands and platforms, and include screenshots for UI changes. Resolve applicable CI failures before merging.
