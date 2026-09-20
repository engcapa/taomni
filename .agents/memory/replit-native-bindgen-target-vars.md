---
name: Replit bindgen target variables
description: Replit Linux native QA bindgen behavior observed while rebuilding the isolated app.
---

On the Replit Linux runner, libspa-sys still reported `stdbool.h` missing when only the generic `BINDGEN_EXTRA_CLANG_ARGS` contained GCC's complete include paths, even though `gcc -print-file-name=include/stdbool.h` resolved a real header. Passing the same arguments through both target-specific names (`BINDGEN_EXTRA_CLANG_ARGS_x86_64-unknown-linux-gnu` and `BINDGEN_EXTRA_CLANG_ARGS_x86_64_unknown_linux_gnu`) allowed compilation to progress past libspa bindgen, but the full build was not completed in that run.

**Why:** Cargo/build-script target matching can prefer a target-specific bindgen environment variable; relying only on the generic variable can leave system headers invisible to libclang.

**How to apply:** Before trusting a native QA build, verify the target-specific variables are exported in the actual Cargo process, then require a fresh adjacent QA identity record. Never run the old binary when that record is absent.