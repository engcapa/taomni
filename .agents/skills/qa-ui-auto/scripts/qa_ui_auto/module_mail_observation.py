"""Observe the real signed Mail host and its data lease in an isolated profile."""

from contextlib import closing
from email import policy
from email.parser import BytesParser
import hashlib
import json
import sqlite3
import time

from . import mail_fake_server
from .module_profile_observation import writer_lease
from .module_retained_observation import ordinary
from .steps import StepError


def run(ctx, args):
    from .fixtures.backup_policy import isolated_data_root
    from .fixtures.module_signed_archive import SIGNED_MAIL_CASES

    owner = ctx.fixture_context
    signed = getattr(owner, "signed_mail", None)
    phase = args.get("phase") if isinstance(args, dict) else args
    active = {
        "folder-tree", "folder-changes", "running", "imap-delivery", "pop3-delivery",
        "attachment-saved", "attachment-reopened", "agenda-written", "filter-saved",
        "contact-saved", "contact-deleted", "responses", "imap-search", "imap-flags", "imap-source",
        "imap-prefetch", "imap-mutations", "outbox-queued", "outbox-sent",
    }
    retained = {"outbox-retained", "contact-retained", "agenda-retained", "filter-retained"}
    if phase not in active | retained | {"idle", "disabled"} or not signed or owner.case_id not in SIGNED_MAIL_CASES:
        raise StepError("The Mail host observation requires the registered signed native case")
    plugins = isolated_data_root(owner) / "plugins"
    receipt = signed["receipt"]
    module = plugins / "mail"
    pointer_path = module / "active.json"
    ordinary(pointer_path)
    pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    version = receipt["version"]
    if pointer.get("activeVersion") != version:
        raise StepError("The native Mail install selected another version")
    version_root = module / "versions" / version
    host = version_root / signed["host"]
    ordinary(host)
    with host.open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    if digest != receipt["hostSha256"]:
        raise StepError("The installed Mail host differs from the verified package")
    frontend = version_root / signed["frontend"]
    ordinary(frontend)
    with frontend.open("rb") as entry:
        frontend_digest = hashlib.file_digest(entry, "sha256").hexdigest()
    if frontend_digest != receipt["frontendSha256"]:
        raise StepError("The installed Mail frontend differs from the verified package")
    observed = writer_lease(plugins, slug="mail", enabled=phase in active)
    report = {"phase": phase, "sourceSha": receipt["sourceSha"], "platform": receipt["platform"],
              "packageSha256": receipt["sha256"], "hostSha256": digest,
              "frontendSha256": frontend_digest, "writerLease": observed}
    if phase.startswith("attachment-"):
        from .module_mail_attachment import observe
        if owner.case_id != "TC-MODULES-083":
            raise StepError("Attachment cache observation requires the signed attachment case")
        observation = observe(module / "data", plugins.parent / "mail-cache", owner.values, signed.get("cachedPart"))
        if phase == "attachment-saved":
            signed["cachedPart"] = observation
        elif not signed.get("cachedPart"):
            raise StepError("Missing the initial attachment download")
        report["cachedPart"] = observation
    if phase.startswith("contact-"):
        from .module_mail_contacts import observe
        if owner.case_id != "TC-MODULES-081":
            raise StepError("Address-book storage requires the signed contact lifecycle case")
        report["contact"] = observe(module / "data", plugins.parent / "mail-cache", phase, signed.get("contact"))
        if phase == "contact-saved":
            signed["contact"] = report["contact"]
    if phase in {"agenda-written", "agenda-retained"}:
        from .module_mail_agenda import observe
        if owner.case_id != "TC-MODULES-091":
            raise StepError("Agenda storage requires the signed calendar case")
        report["agenda"] = observe(module / "data", plugins.parent / "mail-cache")
        if phase == "agenda-written":
            signed["agenda"] = report["agenda"]
        elif report["agenda"] != signed.get("agenda"):
            raise StepError("Disabling Mail changed the stored agenda event")
    if phase == "responses":
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        if "mail/send-response" not in manifest["commands"]:
            raise StepError("The installed Mail version does not implement reply delivery")
        report["responses"] = observe_responses()
    if phase in {"filter-saved", "filter-retained"}:
        if owner.case_id != "TC-MODULES-092":
            raise StepError("Filter storage requires the signed filter case")
        from .module_mail_filters import observe

        report["filter"] = observe(module / "data", plugins.parent / "mail-cache")
        if phase == "filter-saved":
            signed["filter"] = report["filter"]
        elif report["filter"] != signed.get("filter"):
            raise StepError("Disabling Mail changed the saved filter")
    if phase == "imap-prefetch":
        report["prefetch"] = observe_prefetch(args)
    if phase == "imap-mutations":
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        if owner.case_id != "TC-MAIL-BULK-03" or "mail/open-imap-mutations" not in manifest["commands"]:
            raise StepError("The installed Mail version does not provide the signed mutation connection")
        report["mutations"] = observe_mutations()
    if phase in {"outbox-queued", "outbox-retained", "outbox-sent"}:
        if owner.case_id != "TC-MODULES-077":
            raise StepError("Outbox storage requires the signed draft lifecycle case")
        observation = observe_outbox(module / "data", plugins.parent / "mail-cache", phase, signed.get("queuedDraft"))
        report["outbox"] = observation
        if phase == "outbox-queued":
            signed["queuedDraft"] = observation
    (ctx.case_dir / f"signed-mail-{phase}.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return f"Mail {version} host lease verified ({phase})"


def observe_mutations():
    state = mail_fake_server.ACTIVE.state
    with state.lock:
        deleted = [command for command in state.log
                   if command.startswith("UID STORE ") and r"\Deleted" in command]
        expunged = [command for command in state.log if command.startswith("UID EXPUNGE ")]
        copies = list(state.mutation_events)
    if len(deleted) != 3 or len(expunged) != 2:
        raise StepError(f"Expected three STORE attempts and two targeted EXPUNGE commands, got {deleted} and {expunged}")
    return {"transfers": copies, "stores": deleted, "uidExpunges": expunged}


def observe_responses():
    state = mail_fake_server.ACTIVE.state
    parser = BytesParser(policy=policy.default)
    with state.lock:
        sent = list(state.smtp_messages)
        originals = [(parser.parsebytes(message.raw), set(message.flags))
                     for message in state.folders["INBOX"].messages.values()]
    fixture = {message["Subject"]: (message, flags) for message, flags in originals}
    original, flags = fixture["Signed receipt 0001"]
    invite, _ = fixture["Signed calendar 0001"]
    event = next(part for part in invite.walk() if part.get_content_type() == "text/calendar")
    event_uid = next(line for line in event.get_content().splitlines() if line.startswith("UID:"))
    if "$mdnsent" not in {flag.lower() for flag in flags}:
        raise StepError("The IMAP server has no handled-receipt flag on the original message")
    if len(sent) != 2 or any(message["to"] != ["qa-sender@example.com"] for message in sent):
        raise StepError("The SMTP server must receive exactly one invitation reply and one receipt for the requesting sender")
    meeting, receipt = (parser.parsebytes(message["raw"]) for message in sent)
    calendar = next((part for part in meeting.walk() if part.get_content_type() == "text/calendar"), None)
    if calendar is None or calendar.get_param("method", "").upper() != "REPLY":
        raise StepError("The SMTP reply has no calendar REPLY part")
    lines = calendar.get_content().splitlines()
    if event_uid not in lines or "METHOD:REPLY" not in lines or not any("PARTSTAT=TENTATIVE" in line for line in lines):
        raise StepError("The SMTP reply does not reference the selected event and attendance")
    mdn = next((part for part in receipt.walk() if part.get_content_type() == "message/disposition-notification"), None)
    fields = mdn.get_payload(0) if mdn is not None else None
    if (fields is None or fields["Original-Message-ID"] != original["Message-ID"]
            or fields["Disposition"] != "manual-action/MDN-sent-manually; displayed"):
        raise StepError("The read receipt does not identify the original message and manual response")
    return {"calendarUid": event_uid[4:], "messageId": str(original["Message-ID"]),
            "smtpRecipients": [message["to"] for message in sent], "handledFlags": sorted(flags)}


def observe_outbox(module_data, legacy_cache, phase, previous):
    subject = "Signed Outbox ownership"

    def rows(directory, query, params):
        matches = []
        for path in sorted(directory.glob("*.db")):
            ordinary(path)
            with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_drafts'").fetchone():
                    matches.extend((path.name, *row) for row in db.execute(query, params))
        return matches

    query = "SELECT account_id,id,to_json,text_body,reply_context_json FROM mail_drafts WHERE subject=?"
    params = (subject,)
    if previous:
        query += " OR (account_id=? AND id=?)"
        params += (previous["account"], previous["id"])
    if rows(legacy_cache, query, params):
        raise StepError("The legacy Mail cache contains the test draft")
    matches = rows(module_data, query, params)
    if phase == "outbox-sent":
        if not previous or matches or not (module_data / previous["database"]).is_file():
            raise StepError("Sending must remove the original row from the retained module mailbox")
        return {"account": previous["account"], "id": previous["id"], "queued": False}
    if len(matches) != 1:
        raise StepError(f"Expected one queued draft in module storage, found {len(matches)}")
    database, account, draft, recipients, body, context = matches[0]
    with closing(sqlite3.connect((module_data / database).as_uri() + "?mode=ro", uri=True)) as db:
        if not db.execute("SELECT 1 FROM mail_draft_owners WHERE account_id=?", (account,)).fetchone():
            raise StepError("The signed Mail host did not commit ownership of this Outbox")
    outbox = (json.loads(context or "{}") or {}).get("outbox") or {}
    if (json.loads(recipients) != ["receiver@example.com"] or "Keep this scheduled draft" not in body
            or not account or not draft or not outbox.get("sendAt") or outbox.get("attempts") != 0):
        raise StepError("The module draft lost its recipient, message or scheduled Outbox state")
    current = {"database": database, "account": account, "id": draft, "sendAt": outbox["sendAt"], "queued": True}
    if phase == "outbox-retained" and previous != current:
        raise StepError("Disabling Mail changed the identity or schedule of the queued draft")
    return current


def observe_prefetch(args):
    prefix = args.get("subject_prefix", "") if isinstance(args, dict) else ""
    count = args.get("count", 0) if isinstance(args, dict) else 0
    server = mail_fake_server.ACTIVE
    if not server or not isinstance(prefix, str) or not prefix or type(count) is not int or not 2 <= count <= 4:
        raise StepError("IMAP prefetch requires a fixture, subject prefix and a body count from 2 through 4")
    state = server.state
    subjects = {f"Subject: {prefix} {index:04d}".encode() for index in range(1, count + 1)}
    with state.lock:
        uids = sorted(uid for uid, message in state.folders["INBOX"].messages.items()
                      if subjects.intersection(message.raw.split(b"\r\n", 7)[:7]))
    if len(uids) != count:
        raise StepError(f"Expected {count} distinct prefetch fixture messages, found {uids}")
    commands = {f"UID FETCH {uid} ": uid for uid in uids}
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        with state.lock:
            events = list(state.fetch_events)
        by_connection = {}
        for event in events:
            if event["folder"] != "INBOX" or "BODY.PEEK[]<0." not in event["command"]:
                continue
            query, _, _ = event["command"].partition(" (")
            uid = commands.get(f"{query} ")
            if uid is not None and event["bytes"] > 0:
                by_connection.setdefault(event["connection"], {})[uid] = event
        for connection, replies in by_connection.items():
            if sorted(replies) == uids:
                return {"uids": uids, "connection": connection, "fetches": list(replies.values())}
        time.sleep(.1)
    raise StepError(f"IMAP prefetch did not fetch UIDs {uids} on one connection. Observed {by_connection}")
