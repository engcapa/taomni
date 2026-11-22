"""Give the desktop and the browser preview the same old SocksCap settings."""

from __future__ import annotations

import json

from .backup_policy import isolated_data_root


def setup(ctx):
    serialized = json.dumps({
        "enabled": False,
        "mode": "global",
        "apps": [],
        "upstream": {"kind": "socks5", "host": "127.0.0.1", "port": 19391},
        "ruleMode": "gfwList",
        "gfwlist": {"enabled": False, "autoRefreshHours": 24, "url": ""},
        "userRules": [],
        "bypassCidrs": ["127.0.0.0/8"],
        "defaultAction": "direct",
    })
    ctx.values["sockscap_legacy_config"] = serialized
    if (ctx.cfg.get("app") or {}).get("mode") == "native":
        path = isolated_data_root(ctx) / "sockscap" / "config.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(serialized, encoding="utf-8")
