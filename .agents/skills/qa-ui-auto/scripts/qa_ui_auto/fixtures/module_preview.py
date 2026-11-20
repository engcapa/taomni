"""Browser-only module model; no native package, registry or signature is seeded."""
import json


def _seed(ctx, key):
    if (ctx.cfg.get("app") or {}).get("mode", "browser") != "browser":
        raise RuntimeError("module_preview is browser-only; native must install an official signed archive")
    # reset_db's one-per-context script must run before seeding. A subsequent
    # case navigation/reload preserves this explicit preview-only model.
    ctx.page.goto(ctx.cfg["app"]["base_url"])
    ctx.page.evaluate("([key, value]) => localStorage.setItem(key, value)",
                      [key, json.dumps({"lifecycle": "installed", "values": []})])


def setup(ctx):
    _seed(ctx, "taomni.preview.modules.v1")


def setup_vnc(ctx):
    _seed(ctx, "taomni.preview.modules.vnc.v1")
