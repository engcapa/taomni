---
name: Nix native QA toolchain
description: Environment constraints for rebuilding the isolated Linux native QA binary with bindgen on this workspace.
---

For Linux native QA builds in this workspace, choose a `libclang.so` whose ELF type is 64-bit x86-64; Nix can expose multiple same-version clang library outputs, including an unusable 32-bit variant. Pass the complete header search paths reported by `gcc -E -v -` through `BINDGEN_EXTRA_CLANG_ARGS`, including GCC internal headers and the glibc development include directory.

**Why:** bindgen first failed because the selected `libclang.so` was 32-bit, then because clang could not find `stdbool.h`/`stdint.h` even after a valid 64-bit library was selected.

**How to apply:** before `native_build.py`, validate the library with `file -L`, set `LIBCLANG_PATH` to its containing directory, and translate every GCC header search path into `-isystem` arguments. Keep the QA binary and its identity record isolated from production builds.