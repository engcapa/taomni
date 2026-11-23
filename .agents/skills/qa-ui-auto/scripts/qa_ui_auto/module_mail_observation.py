"""Observe the real signed Mail host and its data lease in an isolated profile."""

from contextlib import closing
import base64
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
        "folder-tree", "folder-changes", "running", "imap-delivery", "pop3-delivery", "pop3-sync",
        "attachment-saved", "attachment-reopened", "agenda-written", "filter-saved", "archive-published",
        "archive-cleaned", "archive-original", "cache-cleared", "contact-saved", "contact-deleted", "responses", "imap-search", "imap-flags", "imap-source",
        "imap-prefetch", "imap-mutations", "imap-mbox", "imap-forward", "imap-cache",
        "outbox-queued", "outbox-sent", "imap-account-created", "imap-account-synced",
    }
    retained = {"outbox-retained", "contact-retained", "agenda-retained", "filter-retained", "pop3-retained"}
    active.update({"pop3-saved", "pop3-reopened"})
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
    if phase in {"imap-account-created", "imap-account-synced"}:
        from .module_mail_initialization import observe

        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        if owner.case_id != "TC-MODULES-101" or "mail/initialize-imap-mailbox" not in manifest["commands"]:
            raise StepError("The installed package must declare new IMAP account initialization")
        identity = observe(plugins.parent, phase, signed.get("freshImapAccount"))
        signed["freshImapAccount"] = identity
        report["imapAccount"] = identity
    if phase in {"folder-tree", "folder-changes"}:
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        if "mail/update-imap-folder-cache" not in manifest["commands"]:
            raise StepError("The installed Mail version does not publish its IMAP folder cache")
        report["folderCache"] = observe_folder_cache(plugins.parent / "mail-cache", phase)
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
    if phase in {"imap-delivery", "pop3-delivery"}:
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        if "mail/compose-message" not in manifest["commands"]:
            raise StepError("The installed Mail version does not assemble messages in its host")
        report["delivery"] = observe_delivery(phase)
        if phase == "imap-delivery":
            command = "mail/record-sent-contacts"
            if command not in manifest["commands"]:
                raise StepError("The signed Mail host does not record SMTP recipients")
            report["delivery"]["sentContacts"] = {
                "command": command,
                **observe_sent_contact(plugins.parent / "mail-cache", "receiver@example.com"),
            }
    if phase in {"archive-published", "archive-cleaned", "archive-original", "cache-cleared"}:
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        command = {
            "archive-published": "mail/publish-imap-archive",
            "archive-cleaned": "mail/cleanup-archive-index",
            "archive-original": "mail/open-archive-original",
            "cache-cleared": "mail/imap-archive-scan-state",
        }[phase]
        declared = set(manifest["commands"])
        if owner.case_id != "TC-MODULES-070" or not {command, "mail/imap-archive-scan-state"} <= declared:
            raise StepError("The installed Mail version lacks the required archive command")
        report["archiveCommand"] = command
    if phase == "pop3-sync":
        from .module_mail_pop3 import observe

        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        if "mail/sync-owned-pop3-mailbox" not in manifest["commands"]:
            raise StepError("The installed Mail version does not own the POP3 mailbox")
        server = mail_fake_server.ACTIVE.state
        with server.lock:
            commands = [command for command in server.log if command.startswith("POP3 ")]
        if any(command not in commands for command in ("POP3 UIDL", "POP3 RETR", "POP3 QUIT")):
            raise StepError("The POP3 fixture did not observe a complete mailbox round")
        report["pop3Commands"] = commands
        report["mailbox"] = observe(module / "data", plugins.parent / "mail-cache")
    if phase in {"pop3-saved", "pop3-reopened", "pop3-retained"}:
        from .module_mail_pop3 import observe

        report["mailbox"] = observe(module / "data", plugins.parent / "mail-cache", "Signed-POP3 0001")
        if phase == "pop3-saved":
            signed["pop3Mailbox"] = report["mailbox"]
        elif report["mailbox"] != signed.get("pop3Mailbox"):
            raise StepError("The POP3 UIDL ledger or stored originals changed")
    if phase in {"filter-saved", "filter-retained"}:
        if owner.case_id != "TC-MODULES-092":
            raise StepError("Filter storage requires the signed filter case")
        from .module_mail_filters import observe

        report["filter"] = observe(module / "data", plugins.parent / "mail-cache")
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        if "mail/imap-filter-cache" not in manifest["commands"]:
            raise StepError("The signed Mail host does not own the IMAP filter watermark")
        report["filterWatermark"] = observe_filter_watermark(plugins.parent / "mail-cache")
        if phase == "filter-saved":
            signed["filter"] = report["filter"]
            signed["filterWatermark"] = report["filterWatermark"]
        elif (report["filter"] != signed.get("filter")
              or report["filterWatermark"] != signed.get("filterWatermark")):
            raise StepError("Disabling Mail changed the saved filter or its watermark")
    if phase == "imap-cache":
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        command = "mail/query-account-cache"
        if owner.case_id != "TC-MODULES-098" or command not in manifest["commands"]:
            raise StepError("The installed Mail host does not provide account cache queries")
        server = mail_fake_server.ACTIVE
        if not server or server.state.count("Archive") != 0:
            raise StepError("The fixture must remove the Archive message before the local search")
        report["imapCache"] = {
            "command": command,
            "archiveServerCount": 0,
            **observe_imap_index(plugins.parent / "mail-cache", "Cache-only citation 0001", folder="Archive"),
        }
    if phase == "imap-search" and owner.case_id == "TC-MODULES-059":
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        if "mail/publish-imap-index" not in manifest["commands"]:
            raise StepError("The installed Mail host does not publish the IMAP header index")
        report["imapIndex"] = observe_imap_index(
            plugins.parent / "mail-cache", "Signed full-account header 0001"
        )
    if phase == "imap-flags" and owner.case_id == "TC-MODULES-059":
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        if "mail/publish-imap-flag-cache" not in manifest["commands"]:
            raise StepError("The installed Mail host does not publish the IMAP flag cache")
        report["imapFlags"] = observe_imap_flag_cache(plugins.parent / "mail-cache")
    if phase == "imap-prefetch":
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        if "mail/publish-imap-body-cache" not in manifest["commands"]:
            raise StepError("The installed Mail host does not publish the IMAP body cache")
        report["prefetch"] = observe_prefetch(args, plugins.parent / "mail-cache")
    if phase == "imap-mutations":
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        if owner.case_id != "TC-MAIL-BULK-03" or "mail/run-imap-mutation-job" not in manifest["commands"]:
            raise StepError("The installed Mail version does not own the mutation journal")
        report["mutations"] = observe_mutations()
        report["mutationJournal"] = observe_mutation_journal(plugins.parent / "mail-cache")
    if phase == "imap-mbox":
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        commands = {"mail/open-imap-import", "mail/export-imap-mbox"}
        if owner.case_id != "TC-MODULES-095" or not commands.issubset(manifest["commands"]):
            raise StepError("The installed Mail version does not provide signed mbox transfer")
        report["imports"] = observe_imports()
        report["export"] = observe_export(owner.values["mail_export_mbox"])
    if phase == "imap-forward":
        manifest = json.loads((version_root / "module.json").read_text(encoding="utf-8"))
        commands = {"mail/fetch-imap-raw", "mail/send-smtp"}
        if owner.case_id != "TC-MODULES-096" or not commands.issubset(manifest["commands"]):
            raise StepError("The installed Mail version does not provide signed forwarding")
        report["forward"] = observe_forward()
    if phase in {"outbox-queued", "outbox-retained", "outbox-sent"}:
        if owner.case_id != "TC-MODULES-077":
            raise StepError("Outbox storage requires the signed draft lifecycle case")
        observation = observe_outbox(module / "data", plugins.parent / "mail-cache", phase, signed.get("queuedDraft"))
        report["outbox"] = observation
        if phase == "outbox-queued":
            signed["queuedDraft"] = observation
    (ctx.case_dir / f"signed-mail-{phase}.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return f"Mail {version} host lease verified ({phase})"


def observe_imap_index(root, subject, *, folder="INBOX"):
    databases = sorted(root.glob("*.db"))
    if len(databases) != 1:
        raise StepError(f"Expected one IMAP header index, found {len(databases)}")
    database = databases[0]
    ordinary(database)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as conn:
        rows = conn.execute(
            """SELECT m.uid, f.sync_high_uid, f.uid_validity
               FROM mail_messages AS m
               JOIN mail_folders AS f ON f.account_id=m.account_id AND f.name=m.folder
               WHERE m.folder=? AND m.subject=?""",
            (folder, subject),
        ).fetchall()
    if len(rows) != 1:
        raise StepError(f"The synchronized header was stored {len(rows)} times")
    uid, high, validity = rows[0]
    if high is None or high < uid or validity is None:
        raise StepError("The synchronized header and folder watermark disagree")
    return {"database": database.name, "uid": uid, "highUid": high, "uidValidity": validity}


def observe_imap_flag_cache(root):
    databases = sorted(root.glob("*.db"))
    if len(databases) != 1:
        raise StepError(f"Expected one IMAP flags cache, found {len(databases)}")
    database = databases[0]
    ordinary(database)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as conn:
        rows = conn.execute("SELECT subject, flags_json FROM mail_messages WHERE folder='INBOX'").fetchall()
        folder = conn.execute("SELECT unread FROM mail_folders WHERE name='INBOX'").fetchall()
    flags = [(subject, {flag.lower() for flag in json.loads(value)}) for subject, value in rows]
    selected = [values for subject, values in flags if subject == "Signed full-account header 0001"]
    if len(selected) != 1 or "\\flagged" in selected[0]:
        raise StepError("The cache did not retain the selected message's final star state")
    if folder != [(0,)] or any("\\seen" not in values for _, values in flags):
        raise StepError("The IMAP cache does not record the confirmed folder read state")
    return {"database": database.name, "cachedRows": len(rows), "folderUnread": folder[0][0]}


def observe_folder_cache(root, phase):
    databases = sorted(root.glob("*.db"))
    if len(databases) != 1:
        raise StepError(f"Expected one IMAP folder cache, found {len(databases)}")
    database = databases[0]
    ordinary(database)
    try:
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as conn:
            rows = conn.execute("SELECT name, flags_json FROM mail_folders ORDER BY name").fetchall()
        folders = {name: json.loads(flags) for name, flags in rows}
    except (sqlite3.Error, ValueError) as error:
        raise StepError(f"Cannot read the IMAP folder cache: {error}") from error
    if not {"INBOX", "Archive"}.issubset(folders):
        raise StepError("The cache does not contain the IMAP folder tree")
    subscribed = any(flag.lower() == "\\subscribed" for flag in folders["Archive"])
    if subscribed != (phase == "folder-tree"):
        raise StepError(f"Archive subscription differs from the observed {phase} state")
    retired = {"INBOX/QA module folder", "INBOX/QA module renamed"}
    if phase == "folder-changes" and retired.intersection(folders):
        raise StepError("Renamed or deleted IMAP folders remained in the cache")
    return {"database": database.name, "folders": sorted(folders), "archiveSubscribed": subscribed}


def observe_delivery(phase):
    is_imap = phase == "imap-delivery"
    subject = "Revised signed IMAP delivery" if is_imap else "Signed host POP3 delivery"
    body = f"{'IMAP' if is_imap else 'POP3'} message from the signed Mail host"
    state = mail_fake_server.ACTIVE.state
    parser = BytesParser(policy=policy.default)
    with state.lock:
        deliveries = [
            (mail["to"], parser.parsebytes(mail["raw"])) for mail in state.smtp_messages
        ]
        copies = [parser.parsebytes(mail.raw) for mail in state.folders["Sent"].messages.values()]
    matches = [(to, message) for to, message in deliveries if message["Subject"] == subject]
    if len(matches) != 1 or matches[0][0] != ["receiver@example.com"]:
        raise StepError(f"SMTP did not receive exactly one {subject!r} for its intended recipient")
    message = matches[0][1]
    mime_body = message.get_body()
    if mime_body is None or body not in mime_body.get_content() or not message["Message-ID"]:
        raise StepError("The delivered MIME is missing its body or Message-ID")
    report = {"subject": subject, "messageId": str(message["Message-ID"]), "recipients": matches[0][0]}
    if is_imap:
        matches = [copy for copy in copies if copy["Subject"] == subject]
        if len(matches) != 1 or matches[0]["Message-ID"] != message["Message-ID"]:
            raise StepError("The IMAP Sent copy and SMTP delivery differ in Message-ID")
        sent_body = matches[0].get_body()
        if sent_body is None or body not in sent_body.get_content():
            raise StepError("The IMAP Sent copy is missing the delivered body")
        report["matchingSentCopy"] = True
    return report


def observe_sent_contact(root, email):
    databases = sorted(root.glob("*.db"))
    if len(databases) != 1:
        raise StepError(f"Expected one delivery contact cache, found {len(databases)}")
    database = databases[0]
    ordinary(database)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as conn:
        rows = conn.execute("SELECT sent_count FROM mail_contacts WHERE email=?", (email,)).fetchall()
    if rows != [(1,)]:
        raise StepError(f"The delivered recipient was not recorded exactly once in the account cache: {rows}")
    return {"database": database.name, "email": email, "sentCount": rows[0][0]}


def observe_filter_watermark(root):
    databases = sorted(root.glob("*.db"))
    if len(databases) != 1:
        raise StepError(f"Expected one IMAP filter cache, found {len(databases)}")
    database = databases[0]
    ordinary(database)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=1)) as db:
            rows = db.execute(
                """SELECT w.high_uid, w.uid_validity, f.uid_validity, m.uid
                   FROM mail_filter_marks w
                   JOIN mail_folders f ON f.account_id=w.account_id AND f.name=w.folder
                   JOIN mail_messages m ON m.account_id=w.account_id AND m.folder=w.folder
                   WHERE w.folder='INBOX' AND m.subject='invoice marker 0001'"""
            ).fetchall()
        if len(rows) == 1:
            high, validity, current, retained = rows[0]
            if validity is not None and validity == current and high == retained:
                return {"database": database.name, "uidValidity": validity, "highUid": high}
        time.sleep(.1)
    raise StepError("The filter watermark did not advance to the retained message's UID generation")


def observe_mutation_journal(root):
    databases = sorted(root.glob("*.db"))
    if len(databases) != 1:
        raise StepError(f"Expected one IMAP mutation database, found {len(databases)}")
    database = databases[0]
    ordinary(database)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        rows = db.execute("SELECT folder, finished, payload FROM mail_mutation_jobs ORDER BY id").fetchall()
    jobs = []
    for folder, finished, payload in rows:
        job = json.loads(payload)
        items = job["items"]
        if len(items) != 3 or len({item["uid"] for item in items}) != 3 or not job["validity"]:
            raise StepError("The mutation journal does not retain the expected UID generation or items")
        jobs.append((folder, bool(finished), sorted({item["stage"] for item in items})))
    expected = sorted([
        ("INBOX", True, ["Complete"]),
        ("INBOX", False, ["CopyUncertain"]),
        ("Archive", True, ["Complete"]),
    ])
    if sorted(jobs) != expected:
        raise StepError(f"The mutation journal did not retain confirmed and uncertain outcomes: {jobs}")
    return {"database": database.name, "jobs": jobs}


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


def observe_imports():
    state = mail_fake_server.ACTIVE.state
    parser = BytesParser(policy=policy.default)
    with state.lock:
        imports = [(parser.parsebytes(message.raw), list(message.flags))
                   for message in state.folders["Archive"].messages.values()]
        appends = [command for command in state.log if command.startswith("APPEND ")]
    expected = {"Mbox one": "From the first message", "Mbox two": "The second message",
                "EML import": "The standalone message"}
    contents = {message["Subject"]: message.get_content().rstrip("\r\n") for message, _ in imports}
    if contents != expected or len(imports) != len(expected) or len(appends) != len(expected):
        raise StepError(f"IMAP APPEND content/count mismatch: {contents} with {len(appends)} commands")
    if any(r"\Seen" not in flags for _, flags in imports):
        raise StepError("An imported message is missing the IMAP seen flag")
    return {"appends": appends, "contents": contents, "seen": len(imports)}


def observe_export(path):
    from pathlib import Path

    file = Path(path)
    ordinary(file)
    data = file.read_bytes()
    state = mail_fake_server.ACTIVE.state
    with state.lock:
        fetches = [command for command in state.log if command.endswith("(UID INTERNALDATE BODY.PEEK[])")]
    if sum(line.startswith(b"From - ") for line in data.splitlines()) != 3 or len(fetches) != 1:
        raise StepError("The exported mailbox must contain three separators and one batched IMAP FETCH")
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "fetches": fetches}


def observe_forward():
    state = mail_fake_server.ACTIVE.state
    parser = BytesParser(policy=policy.default)
    subject = "Forward sample 0001"
    with state.lock:
        inbox = [(uid, parser.parsebytes(message.raw)) for uid, message in state.folders["INBOX"].messages.items()]
        sent = list(state.smtp_messages)
        fetches = list(state.fetch_events)
    originals = [(uid, message) for uid, message in inbox if message["Subject"] == subject]
    if len(originals) != 1 or len(sent) != 1 or sent[0]["to"] != ["forward-target@example.com"]:
        raise StepError("The matching original must remain in INBOX and reach only the configured SMTP recipient")
    uid, original = originals[0]
    forwarded = parser.parsebytes(sent[0]["raw"])
    attachments = [part for part in forwarded.iter_attachments() if part.get_content_type() == "message/rfc822"]
    if forwarded["Subject"] != f"Fwd: {subject}" or len(attachments) != 1:
        raise StepError("The forward requires one original message attachment and the original subject")
    part = attachments[0]
    attached = part.get_payload(0)
    if part.get("Content-Transfer-Encoding", "").lower() == "base64":
        attached = parser.parsebytes(base64.b64decode(attached.get_payload()))
    for field in ("Message-ID", "Subject", "From"):
        if attached[field] != original[field]:
            raise StepError(f"Forwarded original changed {field}")
    if attached.get_body().get_content().strip() != original.get_body().get_content().strip():
        raise StepError("Forwarded original changed the message body")
    raw_fetches = [event for event in fetches if event["command"] == f"UID FETCH {uid} (UID BODY.PEEK[])" and event["bytes"] > 0]
    if not raw_fetches:
        raise StepError("The IMAP server recorded no complete raw fetch of the forwarded original")
    return {"messageId": str(original["Message-ID"]), "smtpRecipients": sent[0]["to"], "rawFetches": raw_fetches}


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


def observe_prefetch(args, cache_root):
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
                cached = observe_prefetched_cache(cache_root, uids)
                if cached is not None:
                    return {"uids": uids, "connection": connection,
                            "fetches": list(replies.values()), "cache": cached}
        time.sleep(.1)
    raise StepError(f"IMAP prefetch did not fetch and cache UIDs {uids}. Observed {by_connection}")


def observe_prefetched_cache(root, uids):
    databases = sorted(root.glob("*.db"))
    if not databases:
        return None
    if len(databases) != 1:
        raise StepError(f"Expected one IMAP body cache, found {len(databases)}")
    database = databases[0]
    ordinary(database)
    placeholders = ", ".join("?" for _ in uids)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=1)) as conn:
        rows = conn.execute(
            f"""SELECT uid, subject, body_text, body_html, flags_json
                FROM mail_messages
                WHERE folder='INBOX' AND uid IN ({placeholders}) AND body_cached_at IS NOT NULL
                ORDER BY uid""",
            uids,
        ).fetchall()
    if [row[0] for row in rows] != uids:
        return None
    cached = []
    for uid, subject, text, html, flags in rows:
        content = (text or "") + (html or "")
        if f"Body of {subject}" not in content:
            raise StepError(f"The prefetched body for UID {uid} differs from the delivered message")
        if any(flag.lower() == "\\seen" for flag in json.loads(flags)):
            raise StepError(f"Prefetch marked the unopened UID {uid} as read")
        cached.append({"uid": uid, "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest()})
    return {"database": database.name, "bodies": cached}
