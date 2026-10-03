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

## Testing Guidelines

Frontend tests use Vitest, jsdom, and Testing Library. Colocate `*.test.ts` or `*.test.tsx` with source; run focused tests with `pnpm test -- src/path/example.test.ts`. Rust unit tests live in `#[cfg(test)]` modules.

Cover changed behavior and regressions; Vitest has no configured numeric coverage threshold. UI cases use `TC-XXX-<slug>.testcase.yaml`; follow `qa-ui-auto-tests/README.md` for browser/native runs. Verify native behavior in the desktop app because browser tests use stubs. Live SSH tests require environment credentials and explicit opt-in; see `src-tauri/tests/README.md`.

## Commit & Pull Request Guidelines

Follow the history's Conventional Commit pattern: `fix(screenshot): repair capture controls`, `feat(filebrowser): add folder suggestions`, or `test(rdp): verify viewport`. Keep commits focused.

PRs should explain the problem and resulting behavior, link relevant issues/designs, list validation commands and platforms, and include screenshots for UI changes. Resolve applicable CI failures before merging.
