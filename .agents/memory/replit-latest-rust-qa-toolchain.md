---
name: Replit latest Rust QA toolchain
description: Replit native QA toolchain requirements when the project Rust minimum exceeds pinned Nix modules.
---

Replit's pinned Rust modules can lag behind the project's `rust-version`. Native QA must bootstrap/update rustup's stable channel and verify Cargo before compiling; the current Replit runtime may also reintroduce `LD_AUDIT` when Tauri or Cargo spawns `rustc`, so compiler calls need a PATH-resolved wrapper that executes the real rustc with `LD_AUDIT` removed.

**Why:** The Nix Cargo/nightly toolchains were below the project's minimum, and rustup's compiler failed with `cannot allocate memory in static TLS block` when launched under Replit's audit loader. Tauri's CLI invokes `rustc` by command name, so an environment-only unset was not sufficient.

**How to apply:** Prefer rustup stable latest for Replit native QA, fail if Cargo is below the manifest minimum, put a `rustc` wrapper before rustup shims in PATH, and do not use `--ignore-rust-version` to authorize a build.