---
name: Focused unit commands
description: pnpm argument forwarding can turn a requested focused Vitest run into the full suite.
---

Use `pnpm exec vitest run <exact files>` for focused unit checks in this workspace.

**Why:** With the installed pnpm, `pnpm test -- <files>` forwarded an extra `--`
to Vitest; filenames after it did not restrict collection and an unintended full
unit suite began. A timeout from that command is not targeted verification.

**How to apply:** Check the printed command and selected file count. Use direct
Vitest execution for exact files and `-t` for intentional test-name selection;
distinguish unselected tests from environment skips. Do not infer a full-suite
result from a later focused pass.
