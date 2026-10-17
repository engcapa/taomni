"""Two real QA processes, separate profiles and one shared mailbox directory.

Only fixture preparation copies the already disposable profile. All tested
start/pause/read/move/cleanup actions go through the packaged application's UI.
"""
from __future__ import annotations
import copy
import hashlib
import json
import socket
import sqlite3
import time
from contextlib import ExitStack, suppress
from pathlib import Path
from .mail_performance import UI, text, run as performance
from .mail_storage_oracle import observe
from .steps import StepError


def free_ports():
    with socket.socket() as first, socket.socket() as second:
        first.bind(("127.0.0.1", 0))
        second.bind(("127.0.0.1", 0))
        return first.getsockname()[1], second.getsockname()[1]


def snapshot(source, destination):
    with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as src:
        with sqlite3.connect(destination) as dst:
            src.backup(dst)


def run(ctx, args):
    from native_build import QA_APP_ID
    from tauri_webdriver import NativeHarness, native_isolation_env
    from .native_steps import NativeStepContext
    from . import mail_fake_server
    if getattr(ctx, "dry_run", False):
        return "two isolated native instances"
    report = ctx.case_dir.parent.resolve()
    data = Path(args["data_root"]).resolve()
    root = Path(args["storage_root"]).resolve()
    expected_path = Path(args["expected"]).resolve()
    if not all(path.is_relative_to(report) for path in (data, root, expected_path)) or data.name != QA_APP_ID:
        raise StepError("mail_multi_instance_probe requires report-owned QA paths")
    if mail_fake_server.ACTIVE is None:
        raise StepError("mail_multi_instance_probe requires mail_server")
    server = mail_fake_server.ACTIVE.state
    expected = json.loads(expected_path.read_text())
    peer_root = (ctx.case_dir / "peer").resolve()
    env = native_isolation_env(peer_root)
    peer_data = Path(env.get("NEWMOB_DATA_DIR") or env["XDG_DATA_HOME"]) / QA_APP_ID
    peer_data.mkdir(parents=True)
    for name in ("taomni.db", "vault.db"):
        snapshot(data / name, peer_data / name)
    (peer_data / "backup_policy.json").write_text(json.dumps({"autoBackupEnabled": False, "defaultScope": "core"}))
    cfg = copy.deepcopy(ctx.cfg)
    port, native_port = free_ports()
    cfg.setdefault("webdriver", {}).update(port=port, native_port=native_port)
    result = {"primaryProfile": str(data), "peerProfile": str(peer_data), "sharedStorage": str(root), "passed": False}
    primary = UI(ctx)
    session_name = '[data-testid="session-tree-item"][data-session-name="QA complete mail"]'
    progress = '[data-testid="mail-storage-progress"]'
    target = ctx.case_dir.resolve() / "relocated-shared-mail"
    peer_session = None
    try:
        with NativeHarness(cfg, peer_root) as harness, ExitStack() as cleanup:
            peer_session = harness.create_session()
            def close_peer(session=peer_session):
                with suppress(Exception):
                    session.close()
            cleanup.callback(close_peer)
            peer_ctx = NativeStepContext(peer_session, peer_root, cfg)
            peer = UI(peer_ctx)
            peer.act("wait_for", '[data-testid="vault-unlock-dialog"]')
            peer.act("fill", {"selector": '[data-testid="vault-unlock-pw"]', "value": "qa-mail-storage-password"})
            peer.act("click", '[data-testid="vault-unlock-confirm"]')
            peer.act("wait_for", {"selector": '[data-testid="vault-unlock-dialog"]', "state": "detached", "timeout_sec": 30})
            peer.act("dblclick", session_name)
            peer.until(text(progress) + '.includes("completed")', 30)
            # Keep a chunk in flight long enough to distinguish the two owners.
            with server.lock:
                raw = next(iter(server.folders["INBOX"].messages.values())).raw
                # Leave enough real chunks for terminal startup and all five
                # samples, including the entire permitted 7.5s probe budget.
                raw = raw.replace(b"Subject: Complete INBOX 0", b"Subject: Shared instance original") + b"\r\n" * (8 * 1024 * 1024)
                uid = server.append_raw("INBOX", raw, [])
                oracle = next(value for key, value in expected.items() if key.startswith("INBOX/"))
                expected[f"INBOX/{uid}"] = {**oracle, "sha256": hashlib.sha256(raw).hexdigest(), "rawSize": len(raw)}
                server.archive_chunk_delay = 1
                event_start = len(server.fetch_events)
            primary.act("click", '[data-testid="mail-storage-resume"]')
            primary.until(text(progress) + '.includes("downloading")', 30)
            peer.act("click", '[data-testid="mail-storage-resume"]')
            peer.until(text(progress) + '.includes("syncing in another instance")', 15)
            result["singleOwnerVisible"] = True
            deadline = time.monotonic() + 20
            while not any(path.stat().st_size > 0 for path in root.glob("*.mail/partial/*.part")):
                if time.monotonic() >= deadline:
                    raise StepError("No downloaded prefix became durable before peer pause")
                time.sleep(.05)
            # A peer can pause the owner. Its socket must stop, retaining a
            # byte-exact prefix, and the next owner resumes that prefix.
            peer.act("click", '[data-testid="mail-storage-pause"]')
            primary.until(text(progress) + '.includes("paused")', 15)
            parts = list(root.glob("*.mail/partial/*.part"))
            assert len(parts) == 1, f"Expected one resumable file: {parts}"
            partial = parts[0].read_bytes()
            assert partial and len(partial) < len(raw) and raw.startswith(partial), "Unsafe shared partial MIME"
            result["pausedPrefixBytes"] = len(partial)
            with server.lock:
                previous_owners = sorted({event["connection"] for event in server.fetch_events[event_start:] + server.fetch_inflight
                    if event["command"].startswith(f"UID FETCH {uid} ") and "BODY.PEEK[]<" in event["command"] and "HEADER" not in event["command"]})
                server.archive_chunk_delay = .25
            primary.act("click", '[data-testid="mail-storage-resume"]')
            # The peer's PTY remains responsive while the owner's real chunks
            # continue. It uses the same 5-sample budget as the other case.
            peer.act("click", '[data-testid="new-local-terminal"]')
            peer.act("wait_for", '[data-testid="terminal-pane"][data-terminal-ready="true"]')
            result["terminalReceipt"] = performance(peer_ctx, {"kind": "terminal", "label": "peer-loaded-terminal", "samples": 5, "max_p95_ms": 1500, "require_background": True,
                "background_fetch": {"folder": "INBOX", "uid": uid, "min_offset": len(partial), "exclude_connections": previous_owners}})
            primary.until(text(progress) + '.includes("completed")', 60)
            result["beforeMove"] = observe(root, expected, {"INBOX": 3}, {"INBOX": 3, "Archive": 2})
            with server.lock:
                events = [event for event in server.fetch_events[event_start:]
                          if event["command"].startswith(f"UID FETCH {uid} ") and "BODY.PEEK[]<" in event["command"] and "HEADER" not in event["command"]]
            assert len(events) >= 3, "Full-message chunks did not run"
            assert len({event["connection"] for event in events}) == 2, "Expected exactly one owner before and one after pause"
            result["chunkEvents"] = events
            # Move from the peer; the first process already has a cached DB
            # handle and must follow the durable redirect when reading again.
            peer.act("click", '[data-testid="tab-item"][data-tab-type="mail"]')
            peer.act("click", session_name)
            peer.act("click", '[data-testid="session-edit"]')
            peer.act("wait_for", '[data-testid="session-editor"]')
            peer.act("click", '[data-testid="session-section-mail"]')
            peer.act("fill", {"selector": '[data-testid="mail-storage-directory"]', "value": str(target)})
            peer.act("click", '[data-testid="session-save"]')
            peer.act("wait_for", {"selector": '[data-testid="session-editor"]', "state": "detached", "timeout_sec": 30})
            primary.act("click", '[data-testid="mail-archive-open"]')
            primary.until('document.querySelectorAll(\'[data-testid="mail-archive-row"]\').length === 3', 15)
            primary.act("click", '[data-testid="mail-archive-row"]:first-child [data-testid="mail-archive-read"]')
            primary.until(text('[data-testid="mail-archive-preview"]') + '.includes("complete.bin")', 15)
            result["afterMove"] = observe(target, expected, {"INBOX": 3}, {"Archive": 2})
            # Physical cleanup in the second process must also be visible to
            # the first process and cannot resurrect after a subsequent scan.
            peer.act("click", '[data-testid="mail-archive-open"]')
            peer.until('document.querySelectorAll(\'[data-testid="mail-archive-row"]\').length === 3', 15)
            for index in range(1, 4):
                peer.act("click", f'[data-testid="mail-archive-row"]:nth-child({index}) input[type="checkbox"]')
            peer.act("click", '[data-testid="mail-archive-cleanup"]')
            peer.act("click", '[data-testid="mail-archive-confirm-remove"]')
            peer.until(text('[data-testid="mail-archive-notice"]') + '.includes("Local originals removed")', 20)
            primary.act("click", '[data-testid="mail-archive-refresh"]')
            primary.until('document.querySelectorAll(\'[data-testid="mail-archive-row"]\').length === 0', 10)
            result["afterCleanup"] = observe(target, expected, {}, {"INBOX": 3, "Archive": 2})
            primary.act("click", '[data-testid="mail-archive-close"]')
            primary.act("click", '[data-testid="mail-storage-resume"]')
            primary.until(text(progress) + '.includes("completed")', 30)
            result["afterRescan"] = observe(target, expected, {}, {"INBOX": 3, "Archive": 2})
            peer_session.screenshot(peer_root / "peer-final.png")
            result["peerIdentity"] = json.loads((peer_root / "native-isolation.json").read_text())
            result["passed"] = True
            peer_session.close()
            peer_session = None
    except BaseException as error:
        result["error"] = str(error)
        raise
    finally:
        with server.lock:
            result["fetchEvents"] = list(server.fetch_events)
        if peer_session is not None:
            try:
                peer_session.close()
            except Exception:
                pass
        (ctx.case_dir / "mail-multi-instance.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return "two QA processes: shared ownership, peer pause, terminal response, relocation and cleanup passed"
