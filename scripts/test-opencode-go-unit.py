#!/usr/bin/env python3
"""Run production LLM/chat-store unit modules without the desktop dependency graph.

Generated harness lives under the OS temp directory. No implementation is
duplicated: contracts are read from llm/mod.rs, and modules use absolute #[path]
to this checkout. Only unrelated router/GPU/sidecar registrations are excluded.
The config-path adapter is isolated and is NOT evidence for AppState/config/router.
Use cargo test --lib for those integration/compile boundaries when required.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import tomllib


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cargo", default="cargo")
    parser.add_argument("--filter", default="")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    manifest = tomllib.loads((root / "src-tauri/Cargo.toml").read_text())
    harness = Path(tempfile.gettempdir()) / "taomni-opencode-go-unit"
    (harness / "src").mkdir(parents=True, exist_ok=True)
    keys = ["async-trait", "serde", "serde_json", "tokio", "tokio-util", "uuid",
            "tracing", "rusqlite", "futures", "async-stream", "reqwest", "thiserror", "sha2"]
    dependencies = []
    for key in keys:
        dep = manifest["dependencies"][key]
        if isinstance(dep, str):
            dependencies.append(f'{key} = {json.dumps(dep)}')
        else:
            entries = []
            for name, value in dep.items():
                if isinstance(value, bool):
                    serialized = str(value).lower()
                else:
                    serialized = json.dumps(value)
                entries.append(f'{name} = {serialized}')
            dependencies.append(f'{key} = {{ {", ".join(entries)} }}')
    (harness / "Cargo.toml").write_text(
        '[package]\nname = "taomni-go-unit"\n'
        f'version = {json.dumps(manifest["package"]["version"])}\n'
        'edition = "2024"\n[dependencies]\n' + "\n".join(dependencies) +
        "\n[profile.dev]\ndebug = 0\n[profile.test]\ndebug = 0\n",
    )
    code = (root / "src-tauri/src/llm/mod.rs").read_text()
    keep = {"anthropic", "openai_compat", "opencode_go", "model_catalog"}
    def registration(match):
        name = match.group(1)
        if name not in keep:
            return ""
        path = root / "src-tauri/src/llm" / (f"{name}.rs" if name != "opencode_go" else "opencode_go/mod.rs")
        return f'#[path = {json.dumps(str(path))}] pub mod {name};'
    code = re.sub(r"^pub mod (\w+);$", registration, code, flags=re.M)
    store = root / "src-tauri/src/chat/store.rs"
    (harness / "src/lib.rs").write_text(
        "pub mod llm {\n" + code + "\n}\n"
        f'#[path = {json.dumps(str(store))}] pub mod chat_store;\n'
        f'pub mod ai {{ #[path = {json.dumps(str(root / "src-tauri/src/ai/model_inspector.rs"))}] pub mod model_inspector; '
        "pub mod config { pub fn default_ai_config_path() -> std::path::PathBuf "
        '{ std::env::temp_dir().join("taomni-go-unit-config").join("ai.json") } } }\n',
    )
    print("Scope: production llm contracts, chat/messages/Go transports, shared catalog, inspector core and chat SQLite store.", flush=True)
    print("Excluded: Tauri/AppState, router/config integration, browser/native execution.", flush=True)
    command = [args.cargo, "test", "--offline", "--manifest-path", str(harness / "Cargo.toml"),
               "--lib", "-j", "2"]
    if args.filter:
        command.append(args.filter)
    env = dict(os.environ)
    env.pop("LD_AUDIT", None)
    return subprocess.call(command, cwd=root, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
