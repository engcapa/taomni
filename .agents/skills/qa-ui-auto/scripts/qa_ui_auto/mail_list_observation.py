"""Compare the native mailbox list with the runner-local IMAP fixture."""

from __future__ import annotations

import time
from typing import Any

from .steps import StepError


def assert_list_matches(session: Any, state: Any, args: Any) -> str:
    args = args if isinstance(args, dict) else {}
    folder = str(args.get("folder") or "INBOX")
    deadline = time.monotonic() + float(args.get("timeout_sec", 30))
    observed: Any = None
    server = server_unread = 0
    server_flagged: list[int] = []
    while time.monotonic() < deadline:
        with state.lock:
            messages = state.folders[folder].messages
            server = len(messages)
            server_unread = sum(1 for message in messages.values() if "\\Seen" not in message.flags)
            server_flagged = sorted(
                uid for uid, message in messages.items() if "\\Flagged" in message.flags
            )
        observed = session.execute(
            "const el = document.querySelector('[data-testid=\"mail-message-count\"]');"
            "return {shown: el ? Number(el.getAttribute('data-count')) : -1,"
            " hasMore: el ? el.getAttribute('data-has-more') : null,"
            " unreadRows: document.querySelectorAll('[data-testid=\"mail-message-row\"][data-unread=\"true\"]').length,"
            " flaggedUids: Array.from(document.querySelectorAll("
            "'[data-testid=\"mail-message-row\"][data-flagged=\"true\"]'),"
            " row => Number(row.dataset.uid)).sort((a, b) => a - b)};"
        )
        if (
            isinstance(observed, dict)
            and observed.get("shown") == server
            and observed.get("hasMore") == "false"
            and (not args.get("unread") or observed.get("unreadRows") == server_unread)
            and (not args.get("flagged") or observed.get("flaggedUids") == server_flagged)
        ):
            return f"list matches server: {server} messages, {server_unread} unread"
        if isinstance(observed, dict) and observed.get("hasMore") == "true":
            # Like a user scrolling to the end: load the next cached page.
            session.execute(
                "document.querySelector('[data-testid=\"mail-load-more\"]:not([disabled])')?.click(); return true;"
            )
        time.sleep(0.5)
    raise StepError(
        f"mail_server_assert_list_matches: server={server}, unread={server_unread}, "
        f"flagged UIDs={server_flagged}, ui={observed!r}"
    )
