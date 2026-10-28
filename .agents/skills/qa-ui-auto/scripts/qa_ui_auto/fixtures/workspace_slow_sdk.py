"""A real SDK child process waits on a report-owned gate before returning version.

This exercises SDK resolution before LSP initialize. The five-second production
probe timeout is unchanged. Cases must prove their actions completed while this
child was still alive and waiting, then release it in a finally block.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from typing import Any

from . import workspace_language_files
from . import workspace_slow_lsp


def build_probe(parent: Path) -> dict:
    parent = parent.resolve()
    parent.mkdir(parents=True, exist_ok=False)
    binary_dir = parent / "bin"
    binary_dir.mkdir()
    source = Path(__file__).with_name("held_sdk_probe.rs")
    compiler = shutil.which("rustc")
    if not compiler:
        raise RuntimeError("workspace_slow_sdk requires rustc for its independent native SDK fixture")
    import os
    suffix = ".exe" if os.name == "nt" else ""
    executable = binary_dir / ("java" + suffix)
    command = [compiler, "--edition=2024", "-C", "opt-level=1", "-C", "codegen-units=1",
               "-o", str(executable), str(source)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    (parent / "compile.log").write_text(result.stdout + result.stderr, encoding="utf-8")
    result.check_returncode()
    shutil.copy2(executable, binary_dir / ("javac" + suffix))
    (parent / "events.jsonl").write_text("", encoding="utf-8")
    (parent / "mode").write_text("normal", encoding="utf-8")
    return {
        "home": parent.as_posix(), "events": (parent / "events.jsonl").as_posix(),
        "gate": (parent / "release").as_posix(), "mode": (parent / "mode").as_posix(),
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "binarySha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
        "rustc": subprocess.check_output([compiler, "--version"], text=True).strip(),
    }


def setup(ctx: Any) -> None:
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("workspace_slow_sdk requires the real native SDK/process boundary")
    workspace_language_files.setup(ctx)
    case_dir = Path(ctx.case_dir).resolve()
    manifest = build_probe(case_dir / "held-sdk")
    project = Path(ctx.values["platform_workspace_root"])
    (project / "src" / "Main.java").write_text("public class Main { int value = 1; }\n", encoding="utf-8")
    (project / "build.gradle.kts").write_text('plugins { java }\n', encoding="utf-8")
    (project / "gradle.properties").write_text(
        "org.gradle.java.home=" + manifest["home"] + "\n", encoding="utf-8",
    )
    manifest["workspace"] = project.as_posix()
    (case_dir / "held-sdk-fixture.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    ctx.values.update(slow_sdk_home=manifest["home"], slow_sdk_events=manifest["events"],
                      slow_sdk_gate=manifest["gate"], slow_sdk_mode=manifest["mode"])
    # Keep a real stdio LSP for the final didOpen/dirty-buffer lifecycle. Its
    # initialize gate is already released: only SDK discovery is held here.
    import sys
    lsp_events = case_dir / "sdk-lsp-events.txt"
    lsp_gate = case_dir / "sdk-lsp-release.txt"
    lsp_documents = case_dir / "sdk-lsp-documents.jsonl"
    lsp_events.write_text("", encoding="utf-8")
    lsp_documents.write_text("", encoding="utf-8")
    lsp_gate.write_text("release\n", encoding="utf-8")
    script = Path(workspace_slow_lsp.__file__).with_name("workspace_slow_lsp_server.py").resolve()
    presets = ["typescript-javascript", "java"]
    command = {
        "command": sys.executable,
        "args": " ".join(json.dumps(arg) for arg in [
            script.as_posix(), lsp_events.as_posix(), lsp_gate.as_posix(), lsp_documents.as_posix(),
        ]),
    }
    ctx.values.update(
        slow_lsp_events=lsp_events.as_posix(), slow_lsp_gate=lsp_gate.as_posix(),
        slow_sdk_lsp_documents=lsp_documents.as_posix(),
        slow_sdk_response_report=(case_dir / "sdk-startup-responsiveness.json").as_posix(),
        slow_lsp_prefs=json.dumps({preset: "__custom__" for preset in presets}),
        slow_lsp_command=json.dumps({preset: command for preset in presets}),
    )


def teardown(ctx: Any) -> None:
    gate = getattr(ctx, "values", {}).get("slow_sdk_gate")
    if gate:
        Path(gate).write_text("release\n", encoding="utf-8")
