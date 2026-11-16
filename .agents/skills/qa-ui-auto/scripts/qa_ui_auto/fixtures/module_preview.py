"""Browser-only module model; no native package, registry or signature is seeded."""
import json


def setup(ctx):
    if (ctx.cfg.get("app") or {}).get("mode", "browser") != "browser":
        raise RuntimeError("module_preview is browser-only; native must install an official signed archive")
    # reset_db's one-per-context script must run before seeding. A subsequent
    # case navigation/reload preserves this explicit preview-only model.
    ctx.page.goto(ctx.cfg["app"]["base_url"])
    ctx.page.evaluate("value => localStorage.setItem('taomni.preview.modules.v1', value)",
                      json.dumps({"lifecycle": "installed", "values": []}))
