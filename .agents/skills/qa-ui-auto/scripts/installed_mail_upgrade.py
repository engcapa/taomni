"""Observe an installed monolith's mailbox before and after the first signed Mail upgrade."""

from contextlib import closing
from dataclasses import dataclass
import gzip
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import zipfile

from modular_bundle_inventory import digest
from qa_ui_auto.fixtures.module_legacy_mfa import (
    close_installed_desktop, desktop_action, element, installed_desktop, unlock_vault,
)
from qa_ui_auto.module_profile_observation import writer_lease
from qa_ui_auto.module_retained_observation import assert_code_removed, ordinary
from qa_ui_auto.native_steps import NativeStepContext


ACCOUNT_NAME = "Installed legacy IMAP"
ACCOUNT_ROW = element("session-tree-item") + f'[data-session-name="{ACCOUNT_NAME}"]'
LEGACY_PREFIX = "Legacy installed message"
LEGACY_SUBJECT = f"{LEGACY_PREFIX} 0001"
LEGACY_BODY = "Cached mail created by the installed 0.5.12 application."
NEW_PREFIX = "Post-upgrade installed message"
NEW_SUBJECT = f"{NEW_PREFIX} 0001"
MAIL_ID = "taomni-plugin-mail"
MAIL_PLAN = "migration/mail-provision.json"
MAIL_CARD = element("module-marketplace-card") + f'[data-module-id="{MAIL_ID}"]'


def read_rows(path, query, values):
    ordinary(path)
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        return db.execute(query, values).fetchall()


def read_json(path):
    ordinary(path)
    return json.loads(path.read_text(encoding="utf-8"))


def saved_account(profile):
    rows = read_rows(
        profile / "taomni.db",
        "SELECT id FROM sessions WHERE session_type='Mail' AND name=?",
        [ACCOUNT_NAME],
    )
    if len(rows) != 1:
        raise RuntimeError(f"Expected exactly one Mail account saved by the old desktop, found {len(rows)}")
    return rows[0][0]


def account_stem(account):
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "_", account).strip("_")[:80] or "mail"
    return f"{cleaned}-{hashlib.sha256(account.encode()).hexdigest()[:16]}"


def message_uid(db, account, subject):
    rows = read_rows(
        db, "SELECT uid FROM mail_messages WHERE account_id=? AND folder='INBOX' AND subject=?",
        [account, subject],
    )
    if len(rows) != 1:
        raise RuntimeError(f"Expected one cached {subject!r} in {db.name}, found {len(rows)}")
    return rows[0][0]


def legacy_archive(db, account, uid):
    rows = read_rows(
        db, "SELECT sha256, raw_size FROM mail_full_messages WHERE account_id=? AND folder='INBOX' AND uid=?",
        [account, uid],
    )
    if len(rows) != 1 or not re.fullmatch(r"[0-9a-f]{64}", rows[0][0]):
        raise RuntimeError("The archive does not identify exactly one original for the installed legacy message")
    archive_sha, size = rows[0]
    path = db.with_suffix(".mail") / "objects" / archive_sha[:2] / f"{archive_sha}.eml.gz"
    ordinary(path)
    with gzip.open(path, "rb") as stream:
        original = stream.read()
    if len(original) != size or hashlib.sha256(original).hexdigest() != archive_sha:
        raise RuntimeError("The archived envelope does not match the indexed content")
    if LEGACY_BODY.encode() not in original:
        raise RuntimeError("The archived body differs from the message read in the legacy desktop")
    return path, archive_sha


def sqlite_files(database):
    ordinary(database)
    paths = [database]
    wal = database.with_name(database.name + "-wal")
    if wal.exists() or wal.is_symlink():
        ordinary(wal)
        if wal.stat().st_size:
            paths.append(wal)
    return {path.name: digest(path) for path in paths}


@dataclass(frozen=True)
class LegacyMailbox:
    profile: Path
    account: str
    uid: int
    archive_sha: str
    source_files: dict[str, str]

    @property
    def source_db(self):
        return self.profile / "mail-cache" / f"{account_stem(self.account)}.db"

    @property
    def module_db(self):
        return self.profile / "plugins/mail/data" / self.source_db.name

    @classmethod
    def observe(cls, profile):
        account = saved_account(profile)
        database = profile / "mail-cache" / f"{account_stem(account)}.db"
        uid = message_uid(database, account, LEGACY_SUBJECT)
        path, archive_sha = legacy_archive(database, account, uid)
        files = sqlite_files(database)
        files[path.relative_to(database.parent).as_posix()] = digest(path)
        return cls(profile, account, uid, archive_sha, files)

    def evidence(self):
        return {"accountId": self.account, "uid": self.uid, "originalSha256": self.archive_sha,
                "legacyMailCacheFiles": self.source_files}

    def assert_retained(self):
        if LegacyMailbox.observe(self.profile) != self:
            raise RuntimeError("The upgrade altered the legacy account or the rollback mailbox")
        return self.evidence()

    def assert_migrated(self):
        plan = self.profile / MAIL_PLAN
        if plan.exists() or plan.is_symlink():
            raise RuntimeError("The regular restart did not apply the staged Mail upgrade")
        owner = self.module_db.with_suffix(".imap-owner")
        ordinary(owner)
        if owner.read_text(encoding="utf-8") != f"taomni-imap-store-v1\n{self.module_db.stem}\n":
            raise RuntimeError("The ownership receipt does not identify the old account")
        journal = read_json(self.profile / "migration/journal.json")
        entries = [entry for entry in journal["entries"] if entry["item"] == "mail-accounts"]
        if len(entries) != 1:
            raise RuntimeError("The Mail migration journal lacks a unique account entry")
        entry, = entries
        receipt = read_json(self.module_db.parent / ".legacy-mail-upgrade.json")
        if (entry["state"] != "committed" or entry["target"] != "plugins/mail/data"
                or entry["source_path"] != "taomni.db" or entry["source_fingerprint"] != receipt["source_fingerprint"]
                or not re.fullmatch(r"sha256:[a-f0-9]{64}:bytes:[1-9][0-9]*", entry["source_fingerprint"])):
            raise RuntimeError("The legacy account was not committed to the Mail migration journal")
        if message_uid(self.module_db, self.account, LEGACY_SUBJECT) != self.uid:
            raise RuntimeError("The UID of the old account's cached message changed")
        original, archive_sha = legacy_archive(self.module_db, self.account, self.uid)
        if archive_sha != self.archive_sha:
            raise RuntimeError("The archived message bytes changed after migration")
        self.assert_retained()
        return {"ownershipReceipt": owner.name, "journalEntry": entry, "accountDb": self.module_db.name,
                "archivedMessage": original.relative_to(self.module_db.parent).as_posix(),
                "originalSha256": archive_sha}

    def assert_uninstalled(self, version, synced_uid):
        plugins = self.profile / "plugins"
        root = plugins / "mail"
        result = self.assert_migrated()
        pointer = read_json(root / "active.json")
        if (pointer["activeVersion"] is not None or pointer["previousVersion"] != version
                or not pointer.get("uninstalled")):
            raise RuntimeError("The Mail version was not recorded as uninstalled")
        assert_code_removed(root)
        runtime = root / "runtime"
        if runtime.exists() or runtime.is_symlink():
            raise RuntimeError("Mail uninstall left the module runtime files behind")
        if message_uid(self.module_db, self.account, NEW_SUBJECT) != synced_uid:
            raise RuntimeError("Uninstall did not retain the message synchronized by the new desktop")
        return {**result, "retainedSyncedUid": synced_uid,
                "writerLease": writer_lease(plugins, enabled=False, slug="mail")}


def close_tab(steps, tab_type):
    tab = element("tab-item") + f'[data-tab-type="{tab_type}"]'
    desktop_action(steps, "click", f"{tab} {element('tab-close')}")
    desktop_action(steps, "wait_for", {"selector": tab, "state": "detached"})


def read_original(steps):
    row = element("mail-message-row") + f'[data-subject="{LEGACY_SUBJECT}"]'
    desktop_action(steps, "wait_for", {"selector": row, "timeout_sec": 45})
    desktop_action(steps, "press", {"selector": row, "key": "Enter"})
    desktop_action(steps, "assert_text", {
        "selector": element("mail-reader-text"), "contains": LEGACY_BODY, "timeout_sec": 45,
    })


def open_account(steps, *, signed=False):
    desktop_action(steps, "click", element("nav-mode-home"))
    desktop_action(steps, "click", element("side-tab-sessions"))
    desktop_action(steps, "wait_for", ACCOUNT_ROW)
    desktop_action(steps, "dblclick", ACCOUNT_ROW)
    panel = element("mail-client-tab")
    if signed:
        panel = '[data-testid="plugin-tab-panel"][data-plugin-slug="mail"] ' + panel
    desktop_action(steps, "wait_for", {"selector": panel, "timeout_sec": 45})


def seed_original(ctx, session, evidence, server):
    steps = NativeStepContext(session, evidence, ctx.cfg)
    close_tab(steps, "mfa")
    desktop_action(steps, "click", element("nav-mode-home"))
    desktop_action(steps, "click", element("side-tab-sessions"))
    desktop_action(steps, "click", element("session-new"))
    desktop_action(steps, "wait_for", element("session-editor"))
    desktop_action(steps, "click", element("session-proto-mail"))
    def fill(label, value):
        desktop_action(steps, "fill", {"selector": f'input[aria-label="{label}"]', "value": value})

    for protocol, port in (("IMAP", server.imap_port), ("SMTP", server.smtp_port)):
        fill(f"{protocol} server", "127.0.0.1")
        desktop_action(steps, "select_option", {"selector": element(f"mail-{protocol.lower()}-security"), "value": "None"})
        fill(f"{protocol} port", str(port))
    fill("Mail email or username", "qa@example.com")
    fill("Mail password or app password token", "qa-pass")
    desktop_action(steps, "select_option", {"selector": element("mail-storage-mode"), "value": "include"})
    desktop_action(steps, "click", element("mail-storage-edit-folders"))
    desktop_action(steps, "fill", {"selector": element("mail-storage-folder-names"), "value": "INBOX"})
    desktop_action(steps, "click", element("session-section-bookmark"))
    desktop_action(steps, "fill", {"selector": element("session-name"), "value": ACCOUNT_NAME})
    desktop_action(steps, "click", element("session-save"))
    desktop_action(steps, "wait_for", {"selector": element("session-editor"), "state": "detached", "timeout_sec": 45})
    open_account(steps)
    read_original(steps)
    desktop_action(steps, "assert_text", {
        "selector": element("mail-storage-progress"), "contains": "completed", "timeout_sec": 60,
    })
    desktop_action(steps, "assert_no_runtime_errors", None)


def observe_staging(mailbox, package):
    staged = read_json(mailbox.profile / MAIL_PLAN)
    if staged != {"version": package["version"], "archive_sha256": package["sha256"], "failed": False}:
        raise RuntimeError("The Mail restart did not stage the matching signed catalog package")
    root = mailbox.profile / "plugins/mail"
    active = root / "active.json"
    has_active = (active.exists() or active.is_symlink()) and read_json(active)["activeVersion"] is not None
    stores = [mailbox.module_db, mailbox.module_db.with_suffix(".imap-owner")]
    if has_active or any(path.exists() or path.is_symlink() for path in stores):
        raise RuntimeError("Mail activated or created an account store before the expected restart")
    code = root / "versions" / package["version"] / ".taomni-trust/package.taomni-plugin"
    ordinary(code)
    if digest(code) != package["sha256"]:
        raise RuntimeError("Staged Mail package proof does not match the verified release asset")
    mailbox.assert_retained()
    return staged


def installed_package_identity(profile, package):
    root = profile / "plugins/mail"
    active = read_json(root / "active.json")["activeVersion"]
    if active != package["version"]:
        raise RuntimeError("The active Mail version differs from the staged package")
    directory = root / "versions" / active
    proof = directory / ".taomni-trust/package.taomni-plugin"
    ordinary(proof)
    if digest(proof) != package["sha256"]:
        raise RuntimeError("The installed Mail package differs from the signed release asset")
    hashes = {}
    with zipfile.ZipFile(proof) as archive:
        for key, relative in (("hostSha256", "taomni-plugin-mail"), ("frontendSha256", "frontend/index.js")):
            file = directory / relative
            ordinary(file)
            with archive.open(relative) as archived:
                expected = hashlib.file_digest(archived, "sha256").hexdigest()
            if digest(file) != expected:
                raise RuntimeError(f"The installed Mail {relative} differs from the verified archive")
            hashes[key] = expected
    return {"version": active, "packageSha256": package["sha256"], **hashes}


def stage_on_first_launch(ctx, executable, desktop, evidence, mailbox, package):
    with installed_desktop(ctx, executable, desktop, evidence, "first-mail-stage", timeout=300) as (driver, session):
        steps = unlock_vault(ctx, session, evidence)
        desktop_action(steps, "click", element("ribbon-settings"))
        desktop_action(steps, "fill", {"selector": element("settings-search-input"), "value": "module store"})
        desktop_action(steps, "assert_text", {
            "selector": MAIL_CARD,
            "contains": "Mail will import data from the previous version the next time Taomni opens.",
            "timeout_sec": 210,
        })
        staged = observe_staging(mailbox, package)
        desktop_action(steps, "screenshot", "installed-mail-staged.png")
        desktop_action(steps, "assert_no_runtime_errors", None)
        return {"stage": staged, "shutdown": close_installed_desktop(driver, session, executable)}


def exercise_migrated(steps, mailbox, server, package):
    result = mailbox.assert_migrated()
    result["signedModule"] = installed_package_identity(mailbox.profile, package)
    # Installation and enablement are separate module-store actions.
    desktop_action(steps, "press", {"selector": element("module-action-enable-mail") + ":enabled", "key": "Enter"})
    desktop_action(steps, "wait_for", element("module-action-disable-mail"))
    open_account(steps, signed=True)
    read_original(steps)
    desktop_action(steps, "click", element("mail-archive-open"))
    archive_read = element("mail-archive-read")
    desktop_action(steps, "assert_text", {"selector": archive_read, "contains": LEGACY_SUBJECT})
    desktop_action(steps, "click", archive_read)
    desktop_action(steps, "assert_text", {
        "selector": f"{element('mail-archive-preview')} {element('mail-reader-text')}",
        "contains": LEGACY_BODY, "timeout_sec": 45,
    })
    desktop_action(steps, "screenshot", "installed-mail-migrated-archive.png")
    desktop_action(steps, "click", element("mail-archive-close"))
    result["writerLease"] = writer_lease(mailbox.profile / "plugins", enabled=True, slug="mail")
    uid, = server.state.deliver("INBOX", 1, prefix=NEW_PREFIX)
    desktop_action(steps, "click", element("mail-sync-button") + ":enabled")
    desktop_action(steps, "wait_for", {
        "selector": element("mail-message-row") + f'[data-subject="{NEW_SUBJECT}"]', "timeout_sec": 45,
    })
    if message_uid(mailbox.module_db, mailbox.account, NEW_SUBJECT) != uid:
        raise RuntimeError("The matching UID was not written to the module's database")
    result["syncedUid"] = uid
    mailbox.assert_retained()
    desktop_action(steps, "assert_no_runtime_errors", None)
    close_tab(steps, "mail")
    return result


def exercise_rollback(ctx, executable, desktop, evidence, mailbox):
    retained = mailbox.assert_retained()
    with installed_desktop(ctx, executable, desktop, evidence, "rollback-mail") as (driver, session):
        steps = unlock_vault(ctx, session, evidence)
        open_account(steps)
        read_original(steps)
        desktop_action(steps, "screenshot", "installed-mail-rollback.png")
        desktop_action(steps, "assert_no_runtime_errors", None)
        return {"retainedInput": retained, "shutdown": close_installed_desktop(driver, session, executable)}
