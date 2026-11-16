"""Explicit browser marketplace state, never native signature evidence."""


def setup(ctx):
    if (ctx.cfg.get("app") or {}).get("mode", "browser") != "browser":
        raise RuntimeError("module_marketplace_preview is browser-only")
    ctx.page.goto(ctx.cfg["app"]["base_url"])
    ctx.page.evaluate("""() => {
        localStorage.setItem('taomni.preview.marketplace.v1', 'true');
        localStorage.setItem('taomni.module-catalog-source.v1', 'https://preview.invalid/modules.json');
    }""")
