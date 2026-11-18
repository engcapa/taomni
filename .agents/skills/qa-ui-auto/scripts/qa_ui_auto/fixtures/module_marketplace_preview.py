"""Explicit browser marketplace state, never native signature evidence."""


def setup(ctx):
    if (ctx.cfg.get("app") or {}).get("mode", "browser") != "browser":
        raise RuntimeError("module_marketplace_preview is browser-only")
    ctx.page.goto(ctx.cfg["app"]["base_url"])
    release = ctx.case_id == "TC-MODULES-041"
    ctx.page.evaluate("""release => {
        localStorage.setItem('taomni.preview.marketplace.v1', release ? 'release' : 'true');
        localStorage.setItem('taomni.module-catalog-source.v1', release
            ? 'https://preview.invalid/modules-baseline.json' : 'https://preview.invalid/modules.json');
    }""", release)
