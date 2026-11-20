"""Isolated native Tao Home run against the configured commercial provider.

The API key is supplied through provider-specific environment or a key file;
this fixture never writes it to a report or logs it.  A provider authentication
failure is recorded as an expected key-invalid outcome so a temporary test key
can be checked without turning an expired credential into a product failure.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env

PROVIDERS = {
    "opencode-go": ("OPENCODE", "https://opencode.ai/zen/go/v1", "deepseek-v4.1-flash", "opencode-go"),
    "deepseek-app": ("DEEPSEEK", "https://api.deepseek.com", "deepseek-flash", "deepseek-messages"),
    "agnes": ("AGNES", "https://apihub.agnes-ai.com/v1", "agnes-2.5-pro-beta", "openai-compat"),
}


def setup(ctx):
    if ctx.cfg["app"]["mode"] != "native":
        from . import FixtureSkip
        raise FixtureSkip("tao_real_provider requires native mode")
    provider_id = os.environ.get("TAOMNI_QA_TAO_PROVIDER", "opencode-go" if os.environ.get("TAOMNI_QA_OPENCODE_KEY") or os.environ.get("TAOMNI_QA_OPENCODE_KEY_FILE") else "deepseek-app")
    if provider_id not in PROVIDERS:
        raise ValueError("Unsupported real Tao provider")
    env_name, base_url, model, runtime = PROVIDERS[provider_id]
    key_env = "TAOMNI_QA_" + env_name + "_KEY"
    key = os.environ.get(key_env, "").strip()
    key_file = os.environ.get(key_env + "_FILE", "").strip()
    if not key and key_file:
        key = Path(key_file).read_text(encoding="utf-8-sig").strip()
    if not key:
        from . import FixtureSkip
        raise FixtureSkip(key_env + " is unset; real-provider QA is opt-in")
    expected = native_isolation_env(Path(ctx.report_root).resolve())
    root = Path(expected.get("NEWMOB_CONFIG_DIR") or expected["XDG_CONFIG_HOME"])
    if expected.get("NEWMOB_CONFIG_DIR"):
        root /= QA_APP_ID
    root /= "taomni"
    root.mkdir(parents=True, exist_ok=True)
    proxy_url = os.environ.get("TAOMNI_QA_TAO_PROXY", os.environ.get("TAOMNI_QA_DEEPSEEK_PROXY", "")).strip()
    provider = {
        "base_url": base_url,
        "api_key": key,
        "api_keys": [],
        "model": model,
        "runtime": runtime,
        "proxy_mode": "manual" if proxy_url else "none",
        "proxy_url": proxy_url or None,
        "capabilities": {"chat": True, "image_generation": False, "video_generation": False},
    }
    config = {
        "asr": {"active": "sensevoice-small", "providers": {}, "warm_on_startup": False,
                "vad": "silero", "language": "auto"},
        "llm": {"active": provider_id, "providers": {provider_id: provider},
                "fallback": {"enabled": False, "primary": provider_id, "secondary": "local", "timeout_ms": 30000},
                "task_routing": {}},
        "deepseek_app": {"enabled": True, "provider": provider_id, "model": model, "reasoning_effort": "max", "thinking_default": provider_id == "opencode-go",
                          "search_default": False, "safety_check_high": True, "title_enabled": False,
                          "voice_provider": "local", "tts_voice": "stella", "cost_confirm_threshold_cny": 0.5},
        "full_local_mode": False,
        "fully_disabled": False,
    }
    config_path = root / "ai.json"
    ctx.values["tao_real_provider_config"] = str(config_path)
    config_path.write_text(json.dumps(config), encoding="utf-8")
    (ctx.case_dir / "real-provider-status.txt").write_text("request_prepared\n", encoding="utf-8")
    ctx.values["tao_real_provider_status"] = str(ctx.case_dir / "real-provider-status.txt")
    (ctx.case_dir / "real-provider-config.json").write_text(json.dumps({
        "provider": provider_id, "model": model, "baseUrl": base_url,
        "proxyMode": provider["proxy_mode"],
        "reasoningEffort": "max" if provider_id == "opencode-go" else "high",
        "tokenBudget": 50_000_000 if provider_id == "opencode-go" else 2_000_000,
    }), encoding="utf-8")


def teardown(ctx):
    # Remove the secret-bearing config from the report-owned isolated profile
    # before reports can be archived, including when any case step failed.
    config = ctx.values.pop("tao_real_provider_config", None)
    if config:
        path = Path(config)
        root = Path(ctx.report_root).resolve()
        if not path.resolve().is_relative_to(root) or path.name != "ai.json":
            raise RuntimeError("Real-provider fixture refuses config cleanup outside the QA report")
        path.unlink(missing_ok=True)
    session = getattr(ctx, "session", None)
    if session:
        session.execute("window.__taomniQaTaoProvider?.restore(); return true;")
    # Fixture cleanup is separate from request outcome. Only the assertion
    # records response-complete/credential-invalid; teardown cannot imply pass.
    path = ctx.values.get("tao_real_provider_status")
    if path:
        Path(path).write_text(Path(path).read_text(encoding="utf-8") + "fixture_cleaned\n", encoding="utf-8")
