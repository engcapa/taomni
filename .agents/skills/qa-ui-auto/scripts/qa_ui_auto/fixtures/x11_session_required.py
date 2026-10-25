def setup(ctx):
    if not ctx.cfg.get("ssh_features", {}).get("desktop_command"):
        raise RuntimeError("Real X server fixture is missing; require capability x11_session")
