"""Browser verbs driving the mail server model of the browser stub.

``mail_server_*`` mutate server-side mail "from another client" through
``window.__taomniQaMail`` (src/stubs/mailServerStub.ts); the app still has to
pick the change up through its own sync path. Native equivalents act on the
in-process fake IMAP server (see native_steps.py). Neither proves real
provider interoperability.
"""

from __future__ import annotations

import time
from typing import Any

from . import StepContext, StepError, verb

_CONTROL = "window.__taomniQaMail"


@verb("mail_server_mutation_fault")
def mail_server_mutation_fault(ctx: StepContext, args: Any) -> None:
    """Inject native-receipt outcomes in the browser model for renderer checks."""
    if ctx.dry_run:
        return
    _require_control(ctx)
    ctx.page.evaluate(f"(fault) => {_CONTROL}.mutationFault(fault)", args)


@verb("mail_server_assert_mutations")
def mail_server_assert_mutations(ctx: StepContext, args: Any) -> None:
    if not ctx.dry_run:
        raise StepError("mail_server_assert_mutations requires native IMAP command evidence")


def _require_control(ctx: StepContext) -> None:
    ok = ctx.page.evaluate(f"Boolean({_CONTROL})")  # type: ignore[attr-defined]
    if not ok:
        raise StepError("mail_server: browser stub mail control is unavailable")


def _folder(args: Any) -> str:
    return str((args or {}).get("folder") or "INBOX") if isinstance(args, dict) else "INBOX"


def _count(args: Any, name: str) -> int:
    if not isinstance(args, dict) or not isinstance(args.get("count"), int) or args["count"] < 1:
        raise StepError(f"{name}: expected {{count: positive int, folder?}}")
    return int(args["count"])


@verb("mail_server_deliver")
def mail_server_deliver(ctx: StepContext, args: Any) -> None:
    count = _count(args, "mail_server_deliver")
    if ctx.dry_run:
        return
    _require_control(ctx)
    prefix = str(args.get("prefix") or "QA")
    delivered = ctx.page.evaluate(  # type: ignore[attr-defined]
        f"""([folder, count, prefix, thread, list, invite, receipt]) => {_CONTROL}.accounts()
              .map((id) => {_CONTROL}.deliver(id, folder, count, prefix, thread, list, invite, receipt).length)""",
        [_folder(args), count, prefix, bool(args.get("thread")), args.get("list_unsubscribe") or None,
         args.get("invite") or None, bool(args.get("read_receipt"))],
    )
    if not delivered:
        raise StepError("mail_server_deliver: no browser mail account exists yet; open the mail tab first")


@verb("mail_server_expunge_newest")
def mail_server_expunge_newest(ctx: StepContext, args: Any) -> None:
    count = _count(args, "mail_server_expunge_newest")
    if ctx.dry_run:
        return
    _require_control(ctx)
    ctx.page.evaluate(  # type: ignore[attr-defined]
        f"""([folder, count]) => {_CONTROL}.accounts().forEach((id) => {{
              const uids = {_CONTROL}.observe(id, folder).server.slice(-count);
              {_CONTROL}.expunge(id, folder, uids);
            }})""",
        [_folder(args), count],
    )


@verb("mail_server_set_flags_newest")
def mail_server_set_flags_newest(ctx: StepContext, args: Any) -> None:
    count = _count(args, "mail_server_set_flags_newest")
    flags = args.get("flags")
    if not isinstance(flags, list):
        raise StepError("mail_server_set_flags_newest: flags must be a list")
    if ctx.dry_run:
        return
    _require_control(ctx)
    ctx.page.evaluate(  # type: ignore[attr-defined]
        f"""([folder, count, flags]) => {_CONTROL}.accounts().forEach((id) => {{
              for (const uid of {_CONTROL}.observe(id, folder).server.slice(-count)) {_CONTROL}.setFlags(id, folder, uid, flags);
            }})""",
        [_folder(args), count, [str(flag) for flag in flags]],
    )


@verb("mail_server_assert_folder_count")
def mail_server_assert_folder_count(ctx: StepContext, args: Any) -> None:
    args = args if isinstance(args, dict) else {}
    if ctx.dry_run:
        return
    _require_control(ctx)
    folder = _folder(args)
    minimum = int(args.get("min", 0))
    deadline = time.time() + float(args.get("timeout_sec", 20))
    count = -1
    while time.time() < deadline:
        observed = ctx.page.evaluate(  # type: ignore[attr-defined]
            f"""(folder) => {{
              const ids = {_CONTROL}.accounts();
              if (!ids.length) return {{ count: -1, subjects: [] }};
              return {{
                count: {_CONTROL}.observe(ids[0], folder).server.length,
                subjects: {_CONTROL}.subjects(ids[0], folder),
              }};
            }}""",
            folder,
        )
        count = observed["count"]
        subjects = observed["subjects"]
        if (
            count >= minimum
            and ("equals" not in args or count == int(args["equals"]))
            and ("has_subject" not in args or args["has_subject"] in subjects)
            and ("lacks_subject" not in args or args["lacks_subject"] not in subjects)
        ):
            return
        time.sleep(0.25)
    raise StepError(f"mail_server_assert_folder_count: {folder} has {count}, expected {args!r}")


@verb("mail_server_assert_idle_clients")
def mail_server_assert_idle_clients(ctx: StepContext, args: Any) -> None:
    """IDLE watchers the stub server holds (TASK-12 AC-37: none after close)."""
    args = args if isinstance(args, dict) else {}
    if not isinstance(args.get("equals"), int):
        raise StepError("mail_server_assert_idle_clients: expected {equals: int, timeout_sec?}")
    if ctx.dry_run:
        return
    _require_control(ctx)
    expected = int(args["equals"])
    deadline = time.time() + float(args.get("timeout_sec", 10))
    count = -1
    while time.time() < deadline:
        count = ctx.page.evaluate(f"{_CONTROL}.idleClients()")  # type: ignore[attr-defined]
        if count == expected:
            return
        time.sleep(0.25)
    raise StepError(f"mail_server_assert_idle_clients: {count} IDLE clients, expected {expected}")


@verb("mail_server_assert_caldav_contains")
def mail_server_assert_caldav_contains(ctx: StepContext, args: Any) -> None:
    """The stub calendar holds an event whose summary or UID contains ``text``."""
    args = args if isinstance(args, dict) else {}
    text = args.get("text")
    if not isinstance(text, str) or not text:
        raise StepError("mail_server_assert_caldav_contains: expected {text: str, timeout_sec?}")
    if ctx.dry_run:
        return
    _require_control(ctx)
    deadline = time.time() + float(args.get("timeout_sec", 10))
    while time.time() < deadline:
        if ctx.page.evaluate(f"(text) => {_CONTROL}.caldavContains(text)", text):  # type: ignore[attr-defined]
            return
        time.sleep(0.25)
    raise StepError(f"mail_server_assert_caldav_contains: no calendar event contains {text!r}")


@verb("mail_server_assert_smtp_contains")
def mail_server_assert_smtp_contains(ctx: StepContext, args: Any) -> None:
    """Some message the stub "sent" contains ``text`` (e.g. an iTIP REPLY)."""
    args = args if isinstance(args, dict) else {}
    text = args.get("text")
    if not isinstance(text, str) or not text:
        raise StepError("mail_server_assert_smtp_contains: expected {text: str, timeout_sec?}")
    if ctx.dry_run:
        return
    _require_control(ctx)
    deadline = time.time() + float(args.get("timeout_sec", 10))
    while time.time() < deadline:
        if ctx.page.evaluate(f"(text) => {_CONTROL}.smtpContains(text)", text):  # type: ignore[attr-defined]
            return
        time.sleep(0.25)
    raise StepError(f"mail_server_assert_smtp_contains: no sent message contains {text!r}")


@verb("mail_server_assert_list_matches")
def mail_server_assert_list_matches(ctx: StepContext, args: Any) -> None:
    """The visible, fully loaded list has exactly the server's message count
    (and, with ``unread: true``, the server's unseen count)."""
    args = args if isinstance(args, dict) else {}
    if ctx.dry_run:
        return
    _require_control(ctx)
    folder = _folder(args)
    timeout = float(args.get("timeout_sec", 20))
    deadline = time.time() + timeout
    last: Any = None
    while time.time() < deadline:
        last = ctx.page.evaluate(  # type: ignore[attr-defined]
            f"""(folder) => {{
              const ids = {_CONTROL}.accounts();
              const server = ids.length ? {_CONTROL}.observe(ids[0], folder).server.length : -1;
              const el = document.querySelector('[data-testid="mail-message-count"]');
              return {{
                server,
                shown: el ? Number(el.getAttribute('data-count')) : -1,
                hasMore: el ? el.getAttribute('data-has-more') : null,
                unreadRows: document.querySelectorAll('[data-testid="mail-message-row"][data-unread="true"]').length,
                serverUnread: ids.length ? {_CONTROL}.unseen?.(ids[0], folder) ?? null : null,
              }};
            }}""",
            folder,
        )
        if (
            isinstance(last, dict)
            and last.get("server") == last.get("shown")
            and last.get("hasMore") == "false"
            and (not args.get("unread") or last.get("unreadRows") == last.get("serverUnread"))
        ):
            return
        if isinstance(last, dict) and last.get("hasMore") == "true":
            # Like a user scrolling to the end: load the next cached page.
            ctx.page.evaluate(  # type: ignore[attr-defined]
                "() => document.querySelector('[data-testid=\"mail-load-more\"]:not([disabled])')?.click()"
            )
        time.sleep(0.25)
    raise StepError(f"mail_server_assert_list_matches: list does not match server: {last!r}")


@verb("mail_storage_assert")
def mail_storage_assert(ctx: StepContext, args: Any) -> None:
    if ctx.dry_run:
        return
    raise StepError("mail_storage_assert requires native SQLite and MIME files; browser stubs cannot prove disk storage")


@verb("mail_performance_probe")
def mail_performance_probe(ctx: StepContext, args: Any) -> None:
    from ..mail_performance import run
    run(ctx, args)


@verb("mail_server_delay_next_read")
def mail_server_delay_next_read(ctx: StepContext, args: Any) -> None:
    """Hold one folder-read response to exercise other actions while it is pending."""
    milliseconds = (args or {}).get("milliseconds", 0)
    if not isinstance(milliseconds, int) or not 1 <= milliseconds <= 25000:
        raise StepError("mail_server_delay_next_read: milliseconds must be 1..25000")
    if ctx.dry_run:
        return
    _require_control(ctx)
    ctx.page.evaluate(f"(ms) => {_CONTROL}.delayNextFolderRead(ms)", milliseconds)
