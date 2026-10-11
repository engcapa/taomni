"""Isolated backup UI data and a real loopback Feishu protocol fixture.

Native requests use production HTTP/auth/job/cache paths. Browser uses the
explicit renderer model and never claims network or system-credential evidence.
"""
from __future__ import annotations

import email.parser
import email.policy
import hashlib
import json
import os
import platform
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from typing import Any

from .backup_policy import isolated_data_root


def setup(ctx: Any) -> None:
    now = int(time.time() * 1000)
    device, target, connection = [str(uuid.uuid4()) for _ in range(3)]
    proxy = {"mode": "none", "custom": {"enabled": False, "mode": "manual", "session_id": "", "kind": "http", "host": "", "port": 3128, "username": "", "password_ref": ""}}
    config = {"formatVersion": 1, "device": {"id": device, "name": "QA device"}, "selectedTargetIds": [target], "targets": [{"id": target, "name": "QA cloud", "kind": "feishu", "enabled": True, "connectionId": connection, "rootToken": "", "proxy": proxy, "source": {"kind": "taomni", "schemaVersion": 1, "scope": "core", "customOptions": None}, "writesPaused": False}], "connections": [{"id": connection, "appId": "cli_qa_fixture", "label": "QA application", "origin": "native_registered", "accountId": "ou_qa", "accountName": "QA user", "tenantKey": "qa", "authProtocolVersion": 1, "scopeManifestVersion": 1, "registrationPending": False}]}
    jobs = []
    for phase, operation in [("retry_wait", "download"), ("failed", "download"), ("completed", "download")]:
        job_id = str(uuid.uuid4())
        jobs.append({"id": job_id, "revision": 1, "targetId": target, "operation": operation, "phase": phase, "bytes": 128, "total": 128, "error": "BACKUP_TRANSIENT: synthetic connection failure" if phase != "completed" else None, "artifact": {"path": "fixture", "size": 128, "sha256": "fixture", "snapshotId": "fixture", "sourceKind": "taomni"}, "remote": None, "receipt": None, "createdAt": now - 1000 * len(jobs), "updatedAt": now, "attempts": 1, "nextRetryAt": now + 3600_000 if phase == "retry_wait" else None, "failureKind": "transient" if phase != "completed" else None})
    sessions = [{"id": str(uuid.uuid4()), "targetId": target, "revision": 1, "createdAt": now, "phase": "expired", "verificationUrl": None, "userCode": None, "error": "BACKUP_REGISTRATION_RECOVERY: Previous synthetic registration expired"}]
    ctx.values.update(backup_waiting_id=jobs[0]["id"], backup_failed_id=jobs[1]["id"], backup_completed_id=jobs[2]["id"])
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        state = {"config": {"config": config, "statuses": [{"targetId": target, "connected": True, "passwordConfigured": True}], "cache": {"usedBytes": 384, "limitBytes": 2147483648, "retentionDays": 7}}, "jobs": jobs, "sessions": sessions, "files": []}
        script = "if (!sessionStorage.getItem('qa.backup.seeded')) { localStorage.setItem('taomni.qa.backup.v1', " + json.dumps(json.dumps(state)) + "); sessionStorage.setItem('qa.backup.seeded','1'); }"
        ctx.page.context.add_init_script(script)
        return
    root = isolated_data_root(ctx) / "backup-control"
    if platform.system() == "Linux" and os.environ.get("GITHUB_ACTIONS") == "true":
        if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
            raise RuntimeError("Native backup fixture requires the hosted private D-Bus session")
        # Only GitHub's disposable user/session is unlocked. Never change a
        # developer's keyring or substitute an in-memory store for native QA.
        subprocess.run(["gnome-keyring-daemon", "--unlock", "--components=secrets"], input="qa-disposable-backup-keyring\n", text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=20)
    root.mkdir(parents=True, exist_ok=True)
    (root.parent / "backup_policy.json").write_text(json.dumps({"autoBackupEnabled": False, "frequency": "daily", "maxRetainedCopies": 7, "defaultScope": "core", "customBackupDir": None, "lastBackupAt": None}), encoding="utf-8")
    (root / "config.json").write_text(json.dumps(config), encoding="utf-8")
    for job in jobs:
        folder = root / "artifacts" / job["id"]
        folder.mkdir(parents=True)
        path = folder / "archive.taobak"
        path.write_bytes(b"synthetic cached data" * 8)
        job["artifact"]["path"] = str(path)
        journal = root / "jobs" / (job["id"] + ".json")
        journal.parent.mkdir(exist_ok=True)
        journal.write_text(json.dumps(job), encoding="utf-8")
    (root / "authorization").mkdir(exist_ok=True)
    (root / "authorization" / (sessions[0]["id"] + ".json")).write_text(json.dumps(sessions[0]), encoding="utf-8")
    mode_path = Path(ctx.case_dir) / "backup-service-mode.txt"
    events_path = Path(ctx.case_dir) / "backup-service-events.txt"
    mode_path.write_text("normal", encoding="utf-8")
    events_path.write_text("", encoding="utf-8")
    ctx.values.update(backup_service_mode=str(mode_path), backup_service_events=str(events_path))
    state = {"files": {}, "list_failures": 0, "counter": 0}
    mutex = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_: Any) -> None:
            pass

        def reply(self, status: int, value: Any, binary: bool = False) -> None:
            payload = value if binary else json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Type", "application/octet-stream" if binary else "application/json")
            self.send_header("Retry-After", "0")
            if binary:
                self.send_header("ETag", '"' + hashlib.sha256(payload).hexdigest() + '"')
            self.end_headers()
            self.wfile.write(payload)

        def event(self, text: str) -> None:
            with events_path.open("a", encoding="utf-8") as out:
                out.write(text + "\n")

        def do_GET(self) -> None:
            with mutex:
                path = urlsplit(self.path)
                if mode_path.read_text().strip() == "revoked" or self.headers.get("Authorization") == "Bearer synthetic-qa-access":
                    return self.reply(401, {"code": 99991663})
                if path.path.endswith("/download"):
                    token = path.path.split("/")[-2]
                    data = state["files"][token]["bytes"]
                    self.event("download_sha256=" + hashlib.sha256(data).hexdigest())
                    return self.reply(200, data, True)
                if state["list_failures"] < 3:
                    state["list_failures"] += 1
                    self.event("transient_list_failure")
                    return self.reply(503, {})
                parent = parse_qs(path.query).get("folder_token", [""])[0]
                files = [{k: v for k, v in entry.items() if k not in ("bytes", "parent")} for entry in state["files"].values() if entry["parent"] == parent]
                return self.reply(200, {"code": 0, "data": {"files": files, "has_more": False}})

        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            with mutex:
                if self.path == "/token":
                    if mode_path.read_text().strip() == "revoked":
                        self.event("refresh_rejected")
                        return self.reply(400, {"error": "invalid_grant"})
                    self.event("refresh_ok")
                    return self.reply(200, {"code": 0, "access_token": "synthetic-qa-fresh", "refresh_token": "synthetic-qa-refresh-next", "expires_in": 7200, "refresh_token_expires_in": 86400})
                if self.path.endswith("create_folder"):
                    value = json.loads(body)
                    state["counter"] += 1
                    token = "folder" + str(state["counter"])
                    state["files"][token] = {"token": token, "name": value["name"], "type": "folder", "parent": value["folder_token"]}
                    return self.reply(200, {"code": 0, "data": {"token": token}})
                if self.path.endswith("upload_all"):
                    msg = email.parser.BytesParser(policy=email.policy.default).parsebytes(b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + body)
                    parts = {part.get_param("name", header="content-disposition"): part.get_payload(decode=True) for part in msg.iter_parts()}
                    token = parts.get("file_token", b"").decode()
                    if not token:
                        state["counter"] += 1
                        token = "file" + str(state["counter"])
                    data = parts["file"]
                    state["files"][token] = {"token": token, "name": parts["file_name"].decode(), "type": "file", "parent": parts["parent_node"].decode(), "bytes": data}
                    if parts["file_name"] == b"current.taobak":
                        self.event("upload_sha256=" + hashlib.sha256(data).hexdigest())
                    return self.reply(200, {"code": 0, "data": {"file_token": token, "version": "2"}})
                return self.reply(404, {})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    ctx._backup_server = server
    (root / "qa-fixture.json").write_text(json.dumps({"endpoint": f"http://127.0.0.1:{server.server_port}/", "connection_id": connection, "target_id": target}), encoding="utf-8")


def teardown(ctx: Any) -> None:
    server = getattr(ctx, "_backup_server", None)
    if server:
        server.shutdown()
        server.server_close()
