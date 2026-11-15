"""Isolated native Tao Home run against the configured DeepSeek Messages API.

The API key is supplied only through ``TAOMNI_QA_DEEPSEEK_KEY`` by the caller;
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


def setup(ctx):
    if ctx.cfg["app"]["mode"] != "native":
        from . import FixtureSkip
        raise FixtureSkip("tao_real_provider requires native mode")
    key = os.environ.get("TAOMNI_QA_DEEPSEEK_KEY", "").strip()
    if not key:
        from . import FixtureSkip
        raise FixtureSkip("TAOMNI_QA_DEEPSEEK_KEY is unset; real-provider QA is opt-in")
    expected = native_isolation_env(Path(ctx.report_root).resolve())
    root = Path(expected.get("NEWMOB_CONFIG_DIR") or expected["XDG_CONFIG_HOME"])
    if expected.get("NEWMOB_CONFIG_DIR"):
        root /= QA_APP_ID
    root /= "taomni"
    root.mkdir(parents=True, exist_ok=True)
    proxy_url = os.environ.get("TAOMNI_QA_DEEPSEEK_PROXY", "").strip()
    provider = {
        "base_url": "https://api.deepseek.com",
        "api_key": key,
        "api_keys": [],
        "model": "deepseek-flash",
        "runtime": "deepseek-messages",
        "proxy_mode": "manual" if proxy_url else "none",
        "proxy_url": proxy_url or None,
        "capabilities": {"chat": True, "web_search": True, "file_input": True, "voice": True},
    }
    config = {
        "llm": {"active": "deepseek-app", "providers": {"deepseek-app": provider}},
        "deepseek_app": {"enabled": True, "model": "deepseek-flash", "thinking_default": False,
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
