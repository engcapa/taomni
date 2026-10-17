"""Large disposable mailbox, with controlled network latency outside the server lock."""
from pathlib import Path
from .backup_policy import isolated_data_root
from .. import mail_fake_server


def setup(ctx):
    mode = ctx.cfg.get("app", {}).get("mode", "browser")
    ctx.values["mail_stress_count"] = "33913" if mode == "native" else "1200"
    if mode != "native":
        ctx.values["mail_second_quick_connect"] = "mail://qa-second%40example.com@imap.example.com:993"
        return
    isolated_data_root(ctx)
    server = mail_fake_server.ACTIVE
    if server is None:
        raise RuntimeError("mail_stress requires mail_server")
    state = server.state
    state.header_fetch_delay = 0.15
    state.archive_chunk_delay = 0.15
    # Seed setup is outside measured intervals. 313 larger bodies exercise the
    # body warmup/full-storage lanes in addition to 33,913 summary rows.
    with state.lock:
        state.folders["INBOX"].messages.clear()
        state.deliver("INBOX", 33913, prefix="Stress")
        for uid in sorted(state.folders["INBOX"].messages)[-313:]:
            message = state.folders["INBOX"].messages[uid]
            message.raw += b"Large body payload " * 4096
    ctx.values["mail_second_quick_connect"] = ctx.values["mail_quick_connect"].replace("qa%40", "qa-second%40")
