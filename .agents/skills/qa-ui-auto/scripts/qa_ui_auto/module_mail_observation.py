"""Observe the real signed Mail host and its data lease in an isolated profile."""

import hashlib
import json
import time

from . import mail_fake_server
from .fixtures.backup_policy import isolated_data_root
from .fixtures.module_signed_archive import SIGNED_MAIL_CASES
from .module_profile_observation import writer_lease
from .module_retained_observation import ordinary
from .steps import StepError


def run(ctx, args):
    owner = ctx.fixture_context
    signed = getattr(owner, "signed_mail", None)
    phase = args.get("phase") if isinstance(args, dict) else args
    active = {
        "folder-tree", "folder-changes", "running", "imap-delivery", "pop3-delivery",
        "imap-search", "imap-flags", "imap-source", "imap-prefetch",
    }
    if phase not in active | {"idle", "disabled"} or not signed or owner.case_id not in SIGNED_MAIL_CASES:
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
    if phase == "imap-prefetch":
        report["prefetch"] = observe_prefetch(args)
    (ctx.case_dir / f"signed-mail-{phase}.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return f"Mail {version} host lease verified ({phase})"


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
