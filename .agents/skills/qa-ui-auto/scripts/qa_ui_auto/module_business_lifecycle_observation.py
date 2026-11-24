"""Observe signed business-module version switches, rollback, host lineage, and data continuity."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .module_mfa_lifecycle_observation import digest, inspect_process
from .module_profile_observation import writer_lease
from .module_qa_versions import LIFECYCLE_CASES
from .module_remote_lifecycle_observation import CLIENTS, SERVER_FILES, client_data, server_data, server_runtime, vnc_client_connection
from .module_retained_observation import assert_code_removed, ordinary
from .module_signed_observation import invoke
from .steps import StepError


STATES = {
    "old-enabled": ("previous", None, "enabled"),
    "old-disabled": ("previous", None, "disabled"),
    "updated-disabled": ("current", "previous", "disabled"),
    "rolled-back-disabled": ("previous", "current", "disabled"),
    "old-reenabled": ("previous", "current", "enabled"),
    "updated-enabled": ("current", "previous", "enabled"),
    "failed-update": ("current", "previous", "enabled"),
    "rolled-back-enabled": ("previous", "current", "enabled"),
    "uninstalled": (None, "previous", "uninstalled"),
    "reinstalled": ("current", None, "enabled"),
}

REGISTERED_CASES = {slug: case for case, slug in LIFECYCLE_CASES.items() if slug != "mfa"}
STATELESS_SLUGS = frozenset({"screenshot", "ai-voice-local", "vnc-client"})


def validate(args) -> tuple[str, str]:
    if (
        not isinstance(args, dict)
        or set(args) != {"slug", "phase"}
        or args.get("slug") not in REGISTERED_CASES
        or args.get("phase") not in STATES
    ):
        raise StepError("assert_signed_module_lifecycle requires a registered {slug, phase}")
    return args["slug"], args["phase"]


def inspect_module_process(ctx, slug: str, expected_host: Path | None, previous: dict | None) -> tuple[dict, dict | None]:
    host_names = {f"taomni-plugin-{slug}", f"taomni-plugin-{slug}.exe"}
    if slug == "mfa":
        return inspect_process(ctx, expected_host, previous)
    import psutil
    from native_qa_bridge import identity

    if previous:
        core = identity(previous["core"]["pid"])
        if core != previous["core"]:
            raise StepError(f"The original desktop process exited during the {slug} lifecycle")
        last_host = previous["host"]
        if last_host:
            alive = identity(last_host["pid"])
            if alive and alive["started"] == last_host["started"]:
                raise StepError(f"The previous {slug} process remained alive after switching or stopping the module")
    else:
        core = None

    expected_resolved = expected_host.resolve() if expected_host else None
    candidates = psutil.Process(core["pid"]).children(recursive=True) if core else psutil.process_iter(["pid"])
    matches = []
    for child in candidates:
        try:
            child_path = Path(child.exe()).resolve()
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            continue
        if expected_resolved and child_path == expected_resolved:
            matches.append(child)
        elif child_path.name in host_names and core:
            raise StepError(f"A second or wrong-version {slug} host survived under the desktop")
    if len(matches) != int(expected_resolved is not None):
        raise StepError(f"Unexpected {slug} process count for signed version: {len(matches)}")
    host = None
    if matches:
        process = matches[0]
        host = identity(process.pid)
        desktop = identity(process.ppid())
        if host is None or desktop is None or (core and desktop != core):
            raise StepError(f"The installed {slug} process does not belong to the original desktop")
        core = desktop
    if core is None or Path(core["executable"]).resolve() != ctx.session.application.resolve():
        raise StepError(f"The {slug} module was not launched by this case's QA desktop executable")
    return core, host


def _store_lifecycle_data(owner, slug: str, summary: dict) -> dict:
    baseline = getattr(owner, "module_lifecycle_data", {}).get(slug)
    if baseline and baseline != summary:
        raise StepError(f"The {slug} lifecycle altered its retained module configuration")
    store = getattr(owner, "module_lifecycle_data", None)
    if store is None:
        store = {}
        owner.module_lifecycle_data = store
    store[slug] = summary
    return summary


def verify_module_data(owner, slug: str, module: Path) -> dict:
    if slug in CLIENTS:
        if slug in STATELESS_SLUGS and (module / "data").exists():
            raise StepError(f"Stateless {slug} module unexpectedly created data directory")
        return _store_lifecycle_data(owner, slug, client_data(owner, slug, module))
    if slug in SERVER_FILES:
        return _store_lifecycle_data(owner, slug, server_data(owner, slug, module))
    if slug in STATELESS_SLUGS:
        if (module / "data").exists():
            raise StepError(f"Stateless {slug} module unexpectedly created data directory")
        if slug == "ai-voice-local":
            model_path = getattr(owner, "local_voice_model_path", None)
            model_sha = getattr(owner, "local_voice_model_sha256", None)
            if not model_path or not model_sha or digest(Path(model_path)) != model_sha:
                raise StepError("Local Voice model cache drifted or disappeared across lifecycle")
            return _store_lifecycle_data(owner, slug, {"stateless": True, "modelSha256": model_sha})
        return _store_lifecycle_data(owner, slug, {"stateless": True})
    if slug == "mail":
        from .module_mail_initialization import observe

        previous = getattr(owner, "module_lifecycle_data", {}).get(slug)
        identity = observe(module.parent.parent, "imap-account-synced", previous)
        return _store_lifecycle_data(owner, slug, identity)

    config_path = module / "data/config.json"
    ordinary(config_path)
    raw = config_path.read_bytes()
    parsed = json.loads(raw)
    if slug == "servers":
        http_cfg = (parsed.get("settings") or {}).get("http") or {}
        expected_root = owner.values.get("local_servers_http_root")
        if (
            http_cfg.get("port") != 28489
            or http_cfg.get("bindAddress") != "127.0.0.1"
            or http_cfg.get("rootDir") != expected_root
        ):
            raise StepError(f"Local servers HTTP configuration drifted across lifecycle: {http_cfg!r}")
        summary = {"port": 28489, "bindAddress": "127.0.0.1", "rootDir": expected_root}
    elif slug == "sockscap":
        upstream = parsed.get("upstream") or {}
        password_ref = upstream.get("passwordRef")
        if (
            upstream.get("kind") != "trojan"
            or upstream.get("host") != "127.0.0.2"
            or upstream.get("port") != 19392
            or not isinstance(password_ref, str)
            or not password_ref.startswith("vault:")
        ):
            raise StepError(f"SocksCap upstream configuration drifted across lifecycle: {upstream!r}")
        summary = {"kind": "trojan", "host": "127.0.0.2", "port": 19392, "passwordRef": password_ref}
    else:
        raise StepError(f"Unsupported business lifecycle data check for {slug}")
    summary = _store_lifecycle_data(owner, slug, summary)
    return {"configSha256": hashlib.sha256(raw).hexdigest(), **summary}


def run(ctx, args) -> str:
    slug, phase = validate(args)
    owner = ctx.fixture_context
    packages = getattr(owner, "module_lifecycle", {}).get(slug)
    if not packages or owner.case_id != REGISTERED_CASES[slug]:
        raise StepError("assert_signed_module_lifecycle requires its registered native case and signed inputs")

    from .fixtures.backup_policy import isolated_data_root

    label, previous_label, state = STATES[phase]
    selected = packages[label] if label else None
    version = selected["version"] if selected else None
    previous_version = packages[previous_label]["version"] if previous_label else None
    plugins = isolated_data_root(owner) / "plugins"
    module = plugins / slug
    evidence = {
        "slug": slug,
        "phase": phase,
        "sourceSha": packages["current"]["sourceSha"],
        "platform": packages["current"]["platform"],
        "passed": False,
    }
    try:
        pointer_file = module / "active.json"
        ordinary(pointer_file)
        pointer = json.loads(pointer_file.read_text(encoding="utf-8"))
        evidence["pointer"] = pointer
        if (pointer.get("activeVersion"), pointer.get("previousVersion")) != (version, previous_version):
            raise StepError(f"Unexpected active and rollback versions for {slug}: {pointer!r}")
        if version and previous_version and not isinstance(pointer.get("rollbackUntil"), int):
            raise StepError(f"The active {slug} version has no protected rollback window")

        registry = invoke(ctx.session, "plugin_list").get("value") or []
        record = next((item for item in registry if (item.get("manifest") or {}).get("slug") == slug), None)
        if not record or record.get("state") != state or record.get("reason") or (
            selected and record["manifest"].get("version") != version
        ):
            raise StepError(f"The native registry did not publish the expected {slug} state: {record!r}")
        evidence["state"] = record["state"]

        host = None
        if selected:
            directory = module / "versions" / version
            binary = f"taomni-plugin-{slug}.exe" if selected["platform"].startswith("windows") else f"taomni-plugin-{slug}"
            host = directory / binary
            observed = {
                "packageSha256": digest(directory / ".taomni-trust/package.taomni-plugin"),
                "hostSha256": digest(host),
            }
            expected = {
                "packageSha256": selected["sha256"],
                "hostSha256": selected["hostSha256"],
            }
            if selected.get("frontendSha256"):
                observed["frontendSha256"] = digest(directory / "frontend/index.js")
                expected["frontendSha256"] = selected["frontendSha256"]
            if observed != expected:
                raise StepError(f"Installed {slug} package, host or frontend differs from the signed version")
            evidence.update(observed)
        else:
            assert_code_removed(module)
            if (module / "runtime").exists():
                raise StepError(f"{slug} uninstall must remove code and runtime")
            locator_path = plugins / ".retained-data" / f"{slug}.json"
            ordinary(locator_path)
            locator = json.loads(locator_path.read_text(encoding="utf-8"))
            files = locator.get("files", [])
            if locator.get("slug") != slug:
                raise StepError(f"The retained locator owner does not match {slug}: {locator!r}")
            if slug in STATELESS_SLUGS:
                if record.get("dataRetained") or (module / "data").exists() or files != []:
                    raise StepError(f"Stateless {slug} uninstall must not retain data: {locator!r}")
            else:
                if not record.get("dataRetained"):
                    raise StepError(f"{slug} uninstall must retain module data")
                if slug == "mail":
                    mail_identity = verify_module_data(owner, "mail", module)
                    expected_files = [
                        {"path": mail_identity["database"], "kind": "sqlite"},
                        {"path": mail_identity["receipt"], "kind": "file"},
                    ]
                    if any(item not in files for item in expected_files):
                        raise StepError(f"The retained locator no longer owns Mail database/receipt: {locator!r}")
                elif slug in SERVER_FILES or slug == "rdp-client":
                    expected_files = SERVER_FILES.get(slug, {("data.db", "sqlite")})
                    if {(item.get("path"), item.get("kind")) for item in files} != expected_files:
                        raise StepError(f"The retained locator does not own the expected {slug} files: {locator!r}")
                elif {"path": "config.json", "kind": "file"} not in files:
                    raise StepError(f"The retained locator no longer owns {slug} data/config.json")
            evidence["retainedData"] = locator

        if phase == "failed-update":
            failed = packages["failed"]
            staged = module / "versions" / failed["version"] / ".taomni-trust/package.taomni-plugin"
            if digest(staged) != failed["sha256"]:
                raise StepError(f"The failed {slug} candidate never reached verified staging and real handshake")
            evidence["failedPackageSha256"] = failed["sha256"]
        if phase in {"updated-disabled", "updated-enabled"}:
            release = packages["current"]
            cached = plugins / ".downloads" / (release["sha256"] + ".taomni-plugin")
            transfers = list(owner.module_marketplace.requests).count("/" + release["archive"])
            if transfers != 1 or digest(cached) != release["sha256"]:
                raise StepError(f"Both {slug} updates must use the one verified marketplace download")
            evidence["marketplaceTransfers"] = transfers

        running = state == "enabled"
        evidence["writerLease"] = writer_lease(plugins, enabled=running, slug=slug)
        history = getattr(owner, "module_lifecycle_last", None) or {}
        core, active_host = inspect_module_process(ctx, slug, host if running else None, history.get(slug))
        history[slug] = {"core": core, "host": active_host}
        owner.module_lifecycle_last = history
        evidence.update(core=core, host=active_host, data=verify_module_data(owner, slug, module))
        if slug in SERVER_FILES:
            evidence["listener"] = server_runtime(ctx, slug, phase, active_host)
        if slug == "vnc-client":
            evidence["rfbConnections"] = vnc_client_connection(owner, phase)
        evidence["passed"] = True
        return f"Signed {slug} lifecycle {phase} verified"
    finally:
        with (Path(ctx.case_dir) / f"signed-{slug}-lifecycle.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(evidence) + "\n")
