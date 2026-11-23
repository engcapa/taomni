"""Real Tao provider readiness shared by the fixture and the CI planner.

A missing commercial-provider key must defer the opt-in cases at planning time
instead of burning runners that then fail or skip them.  The fixture and this
module use the same provider table so the readiness decision cannot drift.
"""
from __future__ import annotations

import os
from pathlib import Path

PROVIDERS = {
    "opencode-go": ("OPENCODE", "https://opencode.ai/zen/go/v1", "deepseek-v4.1-flash", "opencode-go"),
    "deepseek-app": ("DEEPSEEK", "https://api.deepseek.com", "deepseek-flash", "deepseek-messages"),
    "agnes": ("AGNES", "https://apihub.agnes-ai.com/v1", "agnes-2.5-pro-beta", "openai-compat"),
}
DEFAULT_PROVIDER = "deepseek-app"
OPT_IN_FIXTURES = ("tao_real_provider",)


def _present(env: dict[str, str], env_name: str) -> bool:
    key_env = "TAOMNI_QA_" + env_name + "_KEY"
    return bool(env.get(key_env, "").strip() or env.get(key_env + "_FILE", "").strip())


def selected_provider(env: dict[str, str] | None = None) -> str:
    env = dict(os.environ if env is None else env)
    provider = env.get("TAOMNI_QA_TAO_PROVIDER", "").strip()
    if provider:
        if provider not in PROVIDERS:
            raise ValueError("Unsupported real Tao provider")
        return provider
    if _present(env, "OPENCODE"):
        return "opencode-go"
    return DEFAULT_PROVIDER


def key_for(env: dict[str, str] | None = None) -> tuple[str, str]:
    """Return ``(provider, key)`` or raise when the key file is unreadable."""
    env = dict(os.environ if env is None else env)
    provider = selected_provider(env)
    env_name = PROVIDERS[provider][0]
    key_env = "TAOMNI_QA_" + env_name + "_KEY"
    key = env.get(key_env, "").strip()
    if not key:
        key_file = env.get(key_env + "_FILE", "").strip()
        if key_file:
            key = Path(key_file).read_text(encoding="utf-8-sig").strip()
    return provider, key


def readiness(env: dict[str, str] | None = None) -> tuple[bool, str]:
    """Return ``(ready, reason)`` without reading the key file content."""
    env = dict(os.environ if env is None else env)
    try:
        provider = selected_provider(env)
    except ValueError as exc:
        return False, str(exc)
    env_name = PROVIDERS[provider][0]
    if _present(env, env_name):
        return True, ""
    key_env = "TAOMNI_QA_" + env_name + "_KEY"
    return False, f"{key_env} is unset; real-provider QA is opt-in"


def opt_in_fixtures() -> tuple[str, ...]:
    return OPT_IN_FIXTURES
