"""Kernel fault/recovery and fixed IPC observations, with no registry mutation."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from linux_noexec import is_noexec
from .fixtures.module_execution import state
from .module_profile_observation import writer_lease
from .module_signed_observation import check, invoke
from .steps import StepError

PHASES = {"block", "rejected", "restore", "recovered"}


def validate(args):
    if not isinstance(args, dict) or set(args) != {"phase"} or args["phase"] not in PHASES:
        raise StepError("module_execution_probe requires one registered fixed phase")
    return args["phase"]


def digest_tree(root):
    if not root.exists():
        return {}
    result = {}
    for path in sorted(root.rglob("*")):
        if path.resolve() != path or path.is_symlink():
            raise StepError("Execution observation rejects symlinked module files")
        if path.is_file():
            result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def snapshot(mount):
    module = mount.target.parent.parent
    pointer = json.loads((module / "active.json").read_text())
    return {"code": digest_tree(mount.target), "data": digest_tree(module / "data"),
            "activeVersion": pointer.get("active_version", pointer.get("activeVersion"))}


def run(ctx, args):
    phase = validate(args)
    mount = state(ctx)
    plugins = mount.target.parent.parent.parent
    observation = {"phase": phase, "passed": False, "target": str(mount.target)}
    try:
        if phase == "block":
            writer_lease(plugins, enabled=False)
            mount.validate()
            mount.original = snapshot(mount)
            if mount.original["activeVersion"] != "0.1.0" or not mount.original["data"]:
                raise StepError("Execution fault requires the trusted installed version and existing user data")
            observation["mount"] = mount.block()
        elif phase in {"rejected", "restore"}:
            if mount.mount_id is None or not is_noexec(mount.target):
                raise StepError("Actual noexec mount is required for a rejection observation")
            if snapshot(mount) != mount.original:
                raise StepError("Noexec failure changed module code, active version or existing data")
            observation["writerLease"] = writer_lease(plugins, enabled=False)
            if phase == "rejected":
                ping = invoke(ctx.session, "plugin_invoke", {"slug": "hello-plugin", "command": "hello/ping"})
                observation["ping"] = ping
                error = ping.get("error", {})
                if error.get("code") != -32004 or not all(value in error.get("message", "") for value in (
                        "MODULE_HOST_NOEXEC", "noexec", "XDG_DATA_HOME", str(mount.target))):
                    raise StepError(f"Native noexec rejection lost its code or recovery advice: {ping!r}")
                if snapshot(mount) != mount.original:
                    raise StepError("Rejected retry mutated installed module data")
                writer_lease(plugins, enabled=False)
            else:
                mount.restore()
                if snapshot(mount) != mount.original:
                    raise StepError("Restoring the test mount changed signed files or user data")
        else:
            if mount.mount_id is not None or is_noexec(mount.target):
                raise StepError("Recover only after the fixture restored the original executable mount")
            current = snapshot(mount)
            if current["code"] != mount.original["code"] or current["activeVersion"] != "0.1.0":
                raise StepError("Recovery must use the same signed version and exact executable bytes")
            records = invoke(ctx.session, "plugin_list").get("value", [])
            matching = [record for record in records if record.get("manifest", {}).get("slug") == "hello-plugin"]
            if len(matching) != 1:
                raise StepError("Recovery lost the single native module record")
            ping = invoke(ctx.session, "plugin_invoke", {"slug": "hello-plugin", "command": "hello/ping"})
            check(matching[0], ping, "enabled")
            read = invoke(ctx.session, "plugin_invoke", {"slug": "hello-plugin", "command": "hello/read"})
            if read.get("value") != {"values": ["preserved before noexec", "saved after noexec"]}:
                raise StepError("Recovered native host did not preserve the original and new user messages")
            observation.update(ping=ping, read=read, writerLease=writer_lease(plugins, enabled=True))
        observation["passed"] = True
        return "module execution " + phase + " verified"
    finally:
        with (Path(ctx.case_dir) / "module-execution-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation, ensure_ascii=False) + "\n")
