"""mail_server: disposable mail endpoint for mail sync cases.

Native mode starts the in-process fake IMAP/SMTP server
(`qa_ui_auto.mail_fake_server`) on 127.0.0.1 ephemeral ports, seeds INBOX and
exposes a Quick Connect URL (plain IMAP, any password) as
``${fixture.mail_quick_connect}``. The real Tauri backend syncs against it.

Browser mode has no network path to IMAP; the same URL shape is served by the
browser stub's server model (`src/stubs/mailServerStub.ts`), which the
``mail_server_*`` verbs drive through ``window.__taomniQaMail``. That proves
renderer orchestration only, never real IMAP.
"""

from __future__ import annotations

from typing import Any

from .. import mail_fake_server

SEED_INBOX = 30


def setup(ctx: Any) -> None:
    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    values: dict[str, str] = getattr(ctx, "values")
    values["mail_mode"] = mode
    if mode != "native":
        values["mail_quick_connect"] = "mail://qa%40example.com@imap.example.com:993"
        # The stub server model is protocol-agnostic; POP3 renders the same.
        values["mail_pop3_quick_connect"] = "pop3://qa%40example.com@pop.example.com:995"
        # The stub agenda only needs a CalDAV URL to be configured.
        values["mail_caldav_quick_connect"] = (
            "mail://qa%40example.com@imap.example.com:993?caldav=https://caldav.example.com/"
        )
        return
    if mail_fake_server.ACTIVE is not None:
        mail_fake_server.ACTIVE.stop()
    server = mail_fake_server.FakeMailServer()
    server.state.deliver("INBOX", SEED_INBOX, prefix="Seed")
    mail_fake_server.ACTIVE = server
    values["mail_imap_port"] = str(server.imap_port)
    values["mail_smtp_port"] = str(server.smtp_port)
    values["mail_quick_connect"] = (
        f"mail://qa%40example.com:qa-pass@127.0.0.1:{server.imap_port}"
        f"?security=none&smtp=127.0.0.1:{server.smtp_port}"
    )
    values["mail_pop3_quick_connect"] = (
        f"pop3://qa%40example.com:qa-pass@127.0.0.1:{server.pop3_port}"
        f"?security=none&smtp=127.0.0.1:{server.smtp_port}"
    )
    values["mail_caldav_quick_connect"] = (
        f"{values['mail_quick_connect']}&caldav=http://127.0.0.1:{server.caldav_port}/"
    )


def teardown(ctx: Any) -> None:
    if mail_fake_server.ACTIVE is not None:
        mail_fake_server.ACTIVE.stop()
        mail_fake_server.ACTIVE = None
