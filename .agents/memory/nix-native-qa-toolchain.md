---
name: Nix native QA toolchain
description: Environment constraints for rebuilding the isolated Linux native QA binary with bindgen on this workspace.
---

For Linux native QA builds in this workspace, choose a `libclang.so` whose ELF type is 64-bit x86-64; Nix can expose multiple same-version clang library outputs, including an unusable 32-bit variant. Pass the complete header search paths reported by `gcc -E -v -` through `BINDGEN_EXTRA_CLANG_ARGS`, including GCC internal headers and the glibc development include directory.

**Why:** bindgen first failed because the selected `libclang.so` was 32-bit, then because clang could not find `stdbool.h`/`stdint.h` even after a valid 64-bit library was selected.

**How to apply:** before `native_build.py`, validate the library with `file -L`, set `LIBCLANG_PATH` to its containing directory, and translate every GCC header search path into `-isystem` arguments. Keep the QA binary and its identity record isolated from production builds.

On the current Replit Linux runner, the native QA build can be killed by the memory limit while compiling the main crate. A low-memory retry should use `CARGO_BUILD_JOBS=1`, disable dev debuginfo/incremental, and preserve the x86-64 `libxkbcommon` library path for the final linker. Adding `RUSTFLAGS` after the first attempt can invalidate the Cargo fingerprint and cause a long dependency rebuild, so prefer `LIBRARY_PATH`/pkg-config paths when they are sufficient.

**Why:** the normal nightly build reached the main crate and received SIGKILL; the low-memory build avoided that but its linker lacked `libxkbcommon`, and a later `RUSTFLAGS=-L` retry forced a broad rebuild that stalled in Cargo.

**How to apply:** treat a missing native identity file as a failed build, not as permission to run the stale binary. If the low-memory build still cannot produce the identity record, report native QA as blocked rather than mixing results from an older artifact.