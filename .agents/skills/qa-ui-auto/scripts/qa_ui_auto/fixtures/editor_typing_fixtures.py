"""Deterministic Java-like typing-latency fixtures for ED-AUDIT-005.

Generates three plain-text files with Java-like content in a fresh host
directory so the packaged app measures the real editor input chain:

* ``Large1MiB.txt``  exactly 1 MiB of chars (1,048,576) across ~8.7k lines,
  under both large-file thresholds, so it stays in full editing mode.
* ``Stress5MiB.txt`` exactly 5 MiB of chars (5,242,880) with the same line
  structure; it crosses the large-file downgrade thresholds and is reported
  separately as the degraded mode, never mixed with the full-editing group.
* ``Small.txt``      a small document (~16k chars) proving ordinary edits do
  not regress.

All files use the ``.txt`` extension on purpose: no language server session
attaches to plain text, so the recorded keydown-to-DOM latency is the
production editor chain itself (CodeMirror transaction -> update listener ->
shared-document owner -> queueEditorTextUpdate -> debounced store flush)
without LSP background traffic. The LSP-active typing state is covered
separately by TC-IDE-C2-04.

The typed key sequences below are fixed constants shared with the case that
consumes this fixture; the ``*_after_*`` hashes are the SHA-256 of the base
content plus those sequences appended at the end of the document, so the case
can verify the final buffer bytes on real disk after a save.
"""

from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path
from typing import Any, Callable

MIB = 1_048_576
FIVE_MIB = 5_242_880

# Fixed typed sequences. The case's native_editor_performance `keys` lists and
# the after-typing hashes both derive from these; keep them in sync.
WARMUP_KEYS = "warmupWarmupWarmupWarmup"
GROUP1_KEYS = ("packmyboxwithfivedozenliquorjugs" * 7)[:200]
GROUP2_KEYS = ("thequickbrownfoxjumpsoverthelazydog" * 6)[:200]


def _java_line(index: int) -> str:
    return (
        f"    public void method{index}() {{ int value{index} = {index}; "
        f"doWork(value{index}, \"literal-{index}-{'a' * 40}\"); }}"
    )


def _build_exact(total_chars: int, line_factory: Callable[[int], str]) -> tuple[str, int]:
    """Build LF-joined Java-like text of exactly `total_chars` chars.

    Returns (text, line_count). The text always ends with exactly one LF and
    the final line is truncated to land on the exact char budget.
    """
    header = "package com.example.perf;\n\npublic class SyntheticFixture {\n"
    body: list[str] = []
    used = len(header)
    index = 0
    while True:
        line = line_factory(index)
        # Reserve one char for this line's LF; the closing brace line is
        # carved out of the final line's budget below.
        if used + len(line) + 1 + 2 > total_chars:
            break
        body.append(line)
        used += len(line) + 1
        index += 1
    remaining = total_chars - used - 3  # final line's LF + the closing "}\n"
    final_line = line_factory(index)[:remaining]
    lines = header.splitlines() + body + [final_line, "}"]
    text = "\n".join(lines) + "\n"
    assert len(text) == total_chars, (len(text), total_chars)
    return text, len(lines)


def setup(ctx: Any) -> None:
    from . import FixtureSkip  # lazy: avoid package-init circular import

    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    if mode != "native":
        raise FixtureSkip(
            "editor_typing_fixtures provisions host files for the packaged "
            "editor; browser-VFS preview cannot observe them"
        )
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    base = report_root / "native-workspaces"
    base.mkdir(parents=True, exist_ok=True)
    case_id = str(getattr(ctx, "case_id", "case"))
    worker = int(getattr(ctx, "worker_id", 0))
    root = Path(tempfile.mkdtemp(prefix=f"{case_id}-perf-w{worker}-", dir=str(base)))

    large_text, large_lines = _build_exact(MIB, _java_line)
    stress_text, stress_lines = _build_exact(FIVE_MIB, _java_line)
    small_text, small_lines = _build_exact(16_384, _java_line)

    typed_suffix = (WARMUP_KEYS + GROUP1_KEYS + GROUP2_KEYS).encode("utf-8")
    files: dict[str, tuple[str, str]] = {
        "Large1MiB.txt": large_text,
        "Stress5MiB.txt": stress_text,
        "Small.txt": small_text,
    }
    values: dict[str, str] = getattr(ctx, "values")
    values["editor_perf_root"] = root.as_posix()
    for name, text in files.items():
        data = text.encode("utf-8")
        stem = Path(name).stem
        (root / name).write_bytes(data)
        values[f"editor_perf_{stem}_sha256"] = hashlib.sha256(data).hexdigest()
        values[f"editor_perf_{stem}_after_sha256"] = hashlib.sha256(
            data + typed_suffix
        ).hexdigest()
        # The workspace editor undoes through WorkspaceDocumentTransactionOwner,
        # which records one undo entry per keystroke transaction (no typed-run
        # grouping), so exactly N undos remove exactly the last N typed chars.
        # The case asserts that deterministic post-undo byte state on disk.
        values[f"editor_perf_{stem}_after_undo4_sha256"] = hashlib.sha256(
            data + typed_suffix[:-4]
        ).hexdigest()
        values[f"editor_perf_{stem}_chars"] = str(len(text))
        values[f"editor_perf_{stem}_lines"] = str(len(text.splitlines()))
        last_line = text.splitlines()[-2]  # index -1 is the closing brace
        values[f"editor_perf_{stem}_last_line_number"] = str(len(text.splitlines()) - 1)
        values[f"editor_perf_{stem}_last_line_len"] = str(len(last_line))
        # CodeMirror counts the trailing LF as one extra empty final line, so
        # Ctrl+End lands on line `cm_lines` col 1; appending the whole typed
        # suffix there ends at col 1 + len(typed_suffix) on the same line.
        cm_lines = len(text.splitlines()) + 1
        values[f"editor_perf_{stem}_cm_lines"] = str(cm_lines)
        values[f"editor_perf_{stem}_cursor_at_end"] = f"Ln {cm_lines}, Col 1"
        values[f"editor_perf_{stem}_cursor_after_append"] = (
            f"Ln {cm_lines}, Col {1 + len(typed_suffix)}"
        )
    # The typed key payloads are exposed as values so the consuming case
    # references ${fixture.*} instead of duplicating the literals; the
    # after-hashes above are computed from exactly these strings.
    values["editor_perf_warmup_keys"] = WARMUP_KEYS
    values["editor_perf_group1_keys"] = GROUP1_KEYS
    values["editor_perf_group2_keys"] = GROUP2_KEYS
    # The 5 MiB stress file types the same measured payload in four 100-key
    # chunks so one WebDriver /actions request never carries 200 paced keys
    # against the slowest document.
    measured_payload = GROUP1_KEYS + GROUP2_KEYS
    for index in range(4):
        values[f"editor_perf_stress_chunk{index + 1}_keys"] = measured_payload[
            index * 100 : (index + 1) * 100
        ]


def teardown(ctx: Any) -> None:
    # Artifacts stay until report rotation prunes qa-ui-auto-report/, matching
    # the workspace_root fixture so failure evidence keeps its inputs.
    _ = getattr(ctx, "values", {}).get("editor_perf_root")
