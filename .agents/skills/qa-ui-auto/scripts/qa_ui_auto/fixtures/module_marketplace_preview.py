"""Explicit browser marketplace state, never native signature evidence."""


def setup(ctx):
    if (ctx.cfg.get("app") or {}).get("mode", "browser") != "browser":
        raise RuntimeError("module_marketplace_preview is browser-only")
    ctx.page.goto(ctx.cfg["app"]["base_url"])
    mode = {"TC-MODULES-041": "release", "TC-MODULES-043": "update"}.get(ctx.case_id, "true")
    ctx.page.evaluate("""mode => {
        localStorage.setItem('taomni.preview.marketplace.v1', mode);
        localStorage.setItem('taomni.module-catalog-source.v1', mode === 'release'
            ? 'https://preview.invalid/modules-baseline.json' : 'https://preview.invalid/modules.json');
        if (mode === 'update') localStorage.setItem('taomni.preview.modules.v1', JSON.stringify({
            version: '0.0.9', lifecycle: 'disabled', values: ['retained across module versions'],
        }));
    }""", mode)
