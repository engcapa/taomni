"""Opt in to the local PTY preview without changing saved sessions or layout.

Browser assertions cover the renderer only. Native cases use the real backend
and this fixture performs no setup in that mode.
"""


def setup(ctx):
    if ctx.cfg.get("app", {}).get("mode") != "browser":
        return
    ctx.page.context.add_init_script(
        "localStorage.setItem('taomni.qa.shell.enabled', 'true');"
    )
