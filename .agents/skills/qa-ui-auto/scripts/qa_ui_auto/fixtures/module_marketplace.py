"""Serve exact officially signed CI inputs; never seed registry or trust state."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import threading

from .module_download import plugin_root
from .module_signed_archive import load_artifact
from . import module_first_release

ORIGIN = "http://127.0.0.1:50301"
BASELINE_CATALOG = "modules-baseline.json"
NEW_MODULE_CATALOG = "modules-new.json"
NEW_MODULE_SEQUENCE = 44
ROSTER_CATALOG = "modules-roster.json"
LATER_ROSTER_CATALOG = "modules-roster-with-optional.json"


class Origin:
    def __init__(self, files, evidence, *, opt_in=False, roster=None, start_catalog=None):
        self.files = files
        self.evidence = evidence
        self.roster = roster
        self.start_catalog = start_catalog or (BASELINE_CATALOG if opt_in else "modules.json")
        current = NEW_MODULE_CATALOG if opt_in else self.start_catalog
        self.current_catalog = files["/" + current]
        self.requests = []
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                with owner.lock:
                    owner.requests.append(self.path)
                    owner.evidence.write_text(json.dumps(owner.requests), encoding="utf-8")
                data = owner.files.get(self.path)
                if data is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                size = data.stat().st_size if isinstance(data, Path) else len(data)
                self.send_header("Content-Length", str(size))
                self.send_header("Connection", "close")
                self.end_headers()
                if isinstance(data, Path):
                    with data.open("rb") as package:
                        shutil.copyfileobj(package, self.wfile)
                else:
                    self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 50301), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .05}, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def fixture_files(root, receipt, *, opt_in=False):
    if Path(receipt["archive"]).name != receipt["archive"]:
        raise RuntimeError("Signed package filename must stay inside its artifact directory")
    # Each case serves only the signed releases it exercises.
    catalogs = (
        [(BASELINE_CATALOG, NEW_MODULE_SEQUENCE - 1, False), (NEW_MODULE_CATALOG, NEW_MODULE_SEQUENCE, True)]
        if opt_in else [("modules.json", 42, True), ("modules-older.json", 41, True)]
    )
    names = [receipt["archive"]]
    for name, _, _ in catalogs:
        names.extend((name, name + ".minisig"))
    if any((root / name).is_symlink() or not (root / name).is_file() for name in names):
        raise RuntimeError("Hosted signed catalog inputs are missing or symlinked")
    files = {"/" + name: (root / name).read_bytes() for name in names}
    for name, sequence, has_plugin in catalogs:
        catalog = json.loads(files["/" + name])
        expected_ids = {receipt["id"]} if has_plugin else set()
        if catalog["sequence"] != sequence or set(catalog["plugins"]) != expected_ids:
            raise RuntimeError("Unexpected signed QA catalog identity")
        if opt_in and catalog["legacyUpgrade"] != []:
            raise RuntimeError("The new module must be outside the legacy enrollment roster")
        if has_plugin:
            plugin = catalog["plugins"][receipt["id"]]
            asset = plugin["platforms"][receipt["platform"]]
            if any(asset.get(key) != receipt[key] for key in ("sha256", "size")) or asset["url"] != f"{ORIGIN}/{receipt['archive']}":
                raise RuntimeError("Signed QA catalog does not bind the matching official artifact")
        signature = files["/" + name + ".minisig"].decode()
        if f"trusted comment: file={name} sourceSha={receipt['sourceSha']}" not in signature.splitlines():
            raise RuntimeError("Signed catalog source identity differs from the native QA binary")
    if opt_in:
        return files
    # Adversarial input keeps the original valid signature and modifies the
    # signed bytes. The actual application's pinned verifier must reject it.
    files["/modules-bad.json"] = files["/modules.json"].replace(b"Hello Plugin", b"Unsigned Name")
    if files["/modules-bad.json"] == files["/modules.json"]:
        raise RuntimeError("Tampered catalog fixture did not change its signed bytes")
    files["/modules-bad.json.minisig"] = files["/modules.json.minisig"]
    return files


def setup(ctx):
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("module_marketplace requires the native pinned verifier")
    plugin_root(ctx)  # validate run-owned isolation before opening any service
    receipt = json.loads((Path(ctx.case_dir) / "official-module-fixture.json").read_text())
    opt_in = ctx.case_id == "TC-MODULES-045"
    files = fixture_files(Path(os.environ["QA_SIGNED_MODULE_ROOT"]), receipt, opt_in=opt_in)
    ctx.module_marketplace = Origin(files, Path(ctx.case_dir) / "module-marketplace-requests.json", opt_in=opt_in)
    ctx.values.update(module_marketplace_url=f"{ORIGIN}/modules.json", module_marketplace_bad_url=f"{ORIGIN}/modules-bad.json",
                      module_marketplace_older_url=f"{ORIGIN}/modules-older.json", module_marketplace_new_url=f"{ORIGIN}/{NEW_MODULE_CATALOG}")


def setup_roster(ctx):
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("module_legacy_roster requires the native pinned verifier")
    plugin_root(ctx)
    receipt = json.loads((Path(ctx.case_dir) / "official-module-fixture.json").read_text(encoding="utf-8"))
    release_run = os.environ.get("QA_FIRST_RELEASE_RUN")
    if ctx.case_id == "TC-MODULES-040" and release_run:
        files, roster, producer = module_first_release.release_inputs(
            Path(os.environ["QA_FIRST_RELEASE_ROOT"]).resolve(), receipt["sourceSha"], release_run, receipt["platform"], ORIGIN,
        )
        return start_first_upgrade(ctx, files, roster, module_first_release.CATALOG, "mail", producer)
    root = Path(os.environ["QA_SIGNED_MODULE_ROOT"])
    hello, hello_archive, _, _ = load_artifact(root, receipt["sourceSha"], receipt["platform"])
    mfa, mfa_archive, _, _ = load_artifact(root / "legacy-roster-mfa", receipt["sourceSha"], receipt["platform"], "mfa")
    skipped_releases = ctx.case_id == "TC-MODULES-046"
    catalog = root / (LATER_ROSTER_CATALOG if skipped_releases else ROSTER_CATALOG)
    signature = catalog.with_name(catalog.name + ".minisig")
    if any(path.is_symlink() or not path.is_file() for path in (catalog, signature)):
        raise RuntimeError("Hosted first-upgrade roster is missing or symlinked")
    raw, detached = catalog.read_bytes(), signature.read_bytes()
    document = json.loads(raw)
    roster = {entry["id"]: entry for entry in (hello, mfa)}
    expected_ids = {mfa["id"]} if skipped_releases else set(roster)
    sequence = NEW_MODULE_SEQUENCE if skipped_releases else 42
    if document["sequence"] != sequence or set(document["legacyUpgrade"]) != expected_ids or document["plugins"].keys() != roster.keys():
        raise RuntimeError("Expected a first-upgrade roster and matching signed entries for Hello and MFA")
    trusted_comment = f"trusted comment: file={catalog.name} sourceSha={receipt['sourceSha']}"
    if trusted_comment not in detached.decode().splitlines():
        raise RuntimeError("First-upgrade roster source identity differs from the native QA binary")
    for key, entry in roster.items():
        asset = document["plugins"][key]["platforms"][entry["platform"]]
        if asset["sha256"] != entry["sha256"] or asset["size"] != entry["size"] or asset["url"] != f"{ORIGIN}/{entry['archive']}":
            raise RuntimeError("First-upgrade roster does not bind the installed package inputs")
    files = {
        "/" + catalog.name: raw,
        "/" + signature.name: detached,
        "/" + hello_archive.name: hello_archive.read_bytes(),
        "/" + mfa_archive.name: mfa_archive.read_bytes(),
    }
    (Path(ctx.case_dir) / "module-legacy-roster.json").write_text(json.dumps(roster, indent=2), encoding="utf-8")
    enrollment = {id: entry for id, entry in roster.items() if id in expected_ids}
    if ctx.case_id == "TC-MODULES-040":
        return start_first_upgrade(ctx, files, enrollment, catalog.name, "hello-plugin")
    ctx.module_marketplace = Origin(files, Path(ctx.case_dir) / "module-marketplace-requests.json",
                                    roster=enrollment, start_catalog=catalog.name)


def start_first_upgrade(ctx, files, roster, catalog, remove, producer=None):
    case = Path(ctx.case_dir)
    primary = roster["taomni-plugin-" + remove]
    evidence = {"catalog": catalog, "sourceSha": primary["sourceSha"], "platform": primary["platform"],
                "removed": primary["slug"], "roster": roster}
    if producer:
        evidence.update(releaseRun=producer["runId"], catalogSha256=producer["catalogSha256"])
    (case / "first-upgrade-input.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    ctx.values["module_roster_remove"] = remove
    ctx.module_marketplace = Origin(files, case / "module-marketplace-requests.json", roster=roster, start_catalog=catalog)


def teardown(ctx):
    origin = getattr(ctx, "module_marketplace", None)
    if origin:
        origin.close()
