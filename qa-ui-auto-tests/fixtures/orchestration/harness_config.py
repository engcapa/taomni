"""Pinned harness launch contracts; config files live only in disposable QA homes."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from receipts import clean_environment, is_linked_worktree

CATALOG_PATH = Path(__file__).resolve().with_name("harness_catalog.json")
DUMMY_KEY = "taomni-fixture-dummy-not-a-real-key"


@dataclass(frozen=True)
class Launch:
    command: list[str]
    env: dict[str, str]
    stdin: bytes
    expected_protocol: str
    identity: dict


def write_private(path: Path, data: dict | str) -> None:
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    content = data if isinstance(data, str) else json.dumps(data, indent=2) + "\n"
    with path.open("x", encoding="utf-8") as output:
        path.chmod(0o600)
        output.write(content)


def fixture_url(base_url: str) -> str:
    parsed = urlsplit(base_url)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port
            or parsed.username or parsed.password or parsed.path != "/v1" or parsed.query or parsed.fragment):
        raise ValueError("fixture endpoint must be exactly http://127.0.0.1:<port>/v1")
    return base_url.removesuffix("/v1")


def verify_installation(installation: dict, harness: str) -> dict:
    if hashlib.sha256(CATALOG_PATH.read_bytes()).hexdigest() != installation.get("catalog_sha256"):
        raise ValueError("installation was produced for a different harness catalog")
    item = installation.get("harnesses", {}).get(harness)
    catalog = json.loads(CATALOG_PATH.read_text())["harnesses"].get(harness)
    if not item or not catalog:
        raise ValueError("required real harness is not installed; unavailable workers cannot be skipped")
    if item.get("protocol") != catalog["protocol"]:
        raise ValueError("installed harness protocol differs from catalog")
    identity = item.get("identity", {})
    for key in ("package", "version", "integrity", "commit"):
        if key in catalog and identity.get(key) != catalog[key]:
            raise ValueError("installed harness identity differs from pinned catalog")
    command = item.get("command")
    if (not isinstance(command, list) or len(command) != 2
            or not all(isinstance(part, str) and Path(part).is_absolute() for part in command)):
        raise ValueError("installation command must name absolute Node and pinned script paths")
    if not all(Path(part).is_file() for part in command):
        raise ValueError("installed harness executable is missing")
    if hashlib.sha256(Path(command[-1]).read_bytes()).hexdigest() != item.get("entrypoint_sha256"):
        raise ValueError("installed harness entrypoint changed after installation")
    return item


def prepare_launch(installation: dict, harness: str, base_url: str, worktree: Path,
                   state_root: Path, prompt: str) -> Launch:
    origin = fixture_url(base_url)
    item = verify_installation(installation, harness)
    if not is_linked_worktree(worktree):
        raise ValueError("worker must run in a physical linked Git worktree")
    if any((parent / ".env").exists() for parent in (worktree, *worktree.parents)):
        raise ValueError("worker worktree ancestors must not contain ambient .env credentials")
    state_root.mkdir(mode=0o700, parents=True, exist_ok=False)
    home = state_root / "home"
    home.mkdir(mode=0o700)
    (home / "tmp").mkdir(mode=0o700)
    node_dir = str(Path(item["command"][0]).parent)
    env = clean_environment(home, node_dir + ":/usr/local/bin:/usr/bin:/bin")
    command = list(item["command"])
    stdin = b""
    if harness == "claude-code":
        env.update(ANTHROPIC_BASE_URL=origin, ANTHROPIC_API_KEY=DUMMY_KEY,
                   ANTHROPIC_DEFAULT_SONNET_MODEL="fixture-worker",
                   ANTHROPIC_DEFAULT_HAIKU_MODEL="fixture-worker", ANTHROPIC_DEFAULT_OPUS_MODEL="fixture-worker",
                   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", DISABLE_AUTOUPDATER="1",
                   DISABLE_TELEMETRY="1", DISABLE_ERROR_REPORTING="1", API_TIMEOUT_MS="30000")
        command += ["--print", "--verbose", "--output-format", "stream-json", "--model", "fixture-worker",
                    "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                    "--tools", "Bash", "--allowedTools", "Bash", "--max-turns", "4", prompt]
    elif harness == "codex":
        codex = home / ".codex"
        env.update(CODEX_HOME=str(codex), TAOMNI_FIXTURE_KEY=DUMMY_KEY)
        write_private(codex / "config.toml", f'''model = "fixture-worker"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "workspace-write"
web_search = "disabled"
check_for_update_on_startup = false
project_doc_max_bytes = 0
[analytics]
enabled = false
[features]
code_mode = false
code_mode_only = false
code_mode_host = false
js_repl = false
remote_models = false
api_key_model_discovery = false
multi_agent = false
plugins = false
shell_snapshot = false
responses_websockets = false
responses_websockets_v2 = false
enable_request_compression = false
[model_providers.fixture]
name = "Taomni isolated fixture"
base_url = "{base_url}"
wire_api = "responses"
env_key = "TAOMNI_FIXTURE_KEY"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 30000
''')
        command += ["exec", "--json", "--ephemeral", "--cd", str(worktree), "-"]
        stdin = prompt.encode()
    elif harness == "pi":
        agent_dir = home / ".pi" / "agent"
        write_private(agent_dir / "models.json", {"providers": {"fixture": {
            "baseUrl": base_url, "api": "openai-completions", "apiKey": DUMMY_KEY,
            "models": [{"id": "fixture-worker", "name": "Fixture worker", "reasoning": False,
                        "input": ["text"], "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                        "contextWindow": 128000, "maxTokens": 4096}]}}})
        env.update(PI_OFFLINE="1")
        command += ["--print", "--mode", "json", "--provider", "fixture", "--model", "fixture-worker",
                    "--thinking", "off", "--tools", "bash", "--no-session", "--offline", "--no-extensions",
                    "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", prompt]
    elif harness == "opencode":
        config = state_root / "opencode.json"
        write_private(config, {"model": "fixture/fixture-worker", "small_model": "fixture/fixture-worker",
            "enabled_providers": ["fixture"], "autoupdate": False, "share": "disabled", "plugin": [],
            "permission": {"*": "deny", "bash": "allow"},
            "agent": {"title": {"disable": True}, "summary": {"disable": True}, "compaction": {"disable": True}},
            "provider": {"fixture": {"npm": "@ai-sdk/openai-compatible", "name": "Fixture",
                "options": {"baseURL": base_url, "apiKey": DUMMY_KEY},
                "models": {"fixture-worker": {"name": "Fixture worker", "tool_call": True,
                    "limit": {"context": 128000, "output": 4096}}}}}})
        env.update(OPENCODE_CONFIG=str(config), OPENCODE_DISABLE_AUTOUPDATE="1", OPENCODE_DISABLE_DEFAULT_PLUGINS="1",
                   OPENCODE_DISABLE_MODELS_FETCH="1", OPENCODE_DISABLE_LSP_DOWNLOAD="1",
                   OPENCODE_DISABLE_AUTOCOMPACT="1", OPENCODE_DISABLE_PROJECT_CONFIG="1",
                   OPENCODE_DISABLE_CLAUDE_CODE="1", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER="1")
        command += ["run", "--format", "json", "--model", "fixture/fixture-worker", prompt]
    elif harness == "deepseek-harness":
        env.update(DSH_HOME=str(home / ".dsh"), DEEPSEEK_API_KEY=DUMMY_KEY, DSH_TELEMETRY_DISABLED="1")
        patch = state_root / "fixture.cordis.yml"
        write_private(patch, f'''- id: llm-deepseek
  config:
    baseURL: {json.dumps(base_url)}
    apiKeyEnv: DEEPSEEK_API_KEY
    thinking: disabled
    reasoningEffort: off
    maxTokens: 4096
    models:
      - id: fixture-worker
        contextWindow: 128000
        maxTokens: 4096
- id: agent-default-model
  config:
    provider: deepseek-official
    model: fixture-worker
    reasoningEffort: off
- id: agent-instructions
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: session-log-deepseek
  disabled: true
''')
        command += ["--profile", "headless", "--patch", str(patch), "--json",
                    "--permission-mode", "workspace-write", "--approval-policy", "never", "-"]
        stdin = prompt.encode()
    elif harness == "zcode":
        config = home / ".zcode" / "v2" / "provider_config.json"
        env.update(ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=str(config), ZCODE_DATA_BASE_DIR=str(home / ".zcode"),
                   ZCODE_STORAGE_DIR=str(home / "storage"), ZCODE_SESSION_DB_PATH=str(home / "sessions.sqlite"),
                   ZCODE_LOG_DIR=str(home / "logs"), ZCODE_NO_PROXY="127.0.0.1,localhost")
        write_private(config, {"schemaVersion": 1, "config": {
            "providerConfigRules": {"providerRules": [{"providerId": "fixture", "providerName": "Fixture",
                "config": {"group": "standard-personal", "access": {"type": "api-key", "apiKey": DUMMY_KEY},
                           "api": {"type": "openai-chat-completions", "baseUrl": base_url},
                           "personalModelIds": ["fixture-worker"]}}]},
            "modelConfigRules": {"providerModelRules": [], "manualProviderModelRules": []},
            "defaultModelSelection": {"providerId": "fixture", "modelId": "fixture-worker"}}})
        write_private(home / ".zcode" / "cli" / "config.json", {
            "features": {"mcp": False, "subagent": False, "memory": False, "skill": False},
            "memory": {"use": False}, "plugins": {"enabled": False}, "skills": {"enabled": False},
            "hooks": {"enabled": False}, "modelStream": {"idleTimeoutMs": 30000}})
        command += ["--prompt", prompt, "--cwd", str(worktree), "--mode", "yolo",
                    "--output-format", "stream-json", "--workflow-mode", "disabled", "--no-color",
                    "--disallowed-tools", "AskUserQuestion EnterPlanMode ExitPlanMode Agent Task"]
    else:
        raise ValueError("unresolved harness launch contract")
    return Launch(command, env, stdin, item["protocol"], {**item["identity"],
                  "entrypoint": item["command"][-1], "entrypoint_sha256": item["entrypoint_sha256"]})
