"""Serve exact officially signed CI inputs; never seed registry or trust state."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading

from .module_download import plugin_root

ORIGIN = "http://127.0.0.1:50301"


class Origin:
    def __init__(self, files, evidence):
        self.files = files
        self.evidence = evidence
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
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 50301), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .05}, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def fixture_files(root, receipt):
    if Path(receipt["archive"]).name != receipt["archive"]:
        raise RuntimeError("Signed package filename must stay inside its artifact directory")
    names = ["modules.json", "modules.json.minisig", "modules-older.json", "modules-older.json.minisig", receipt["archive"]]
    if any((root / name).is_symlink() or not (root / name).is_file() for name in names):
        raise RuntimeError("Hosted signed catalog inputs are missing or symlinked")
    files = {"/" + name: (root / name).read_bytes() for name in names}
    for name, sequence in [("modules.json", 42), ("modules-older.json", 41)]:
        catalog = json.loads(files["/" + name])
        plugin = catalog["plugins"][receipt["id"]]
        asset = plugin["platforms"][receipt["platform"]]
        if catalog["sequence"] != sequence or set(catalog["plugins"]) != {receipt["id"]}:
            raise RuntimeError("Unexpected signed QA catalog identity")
        if any(asset.get(key) != receipt[key] for key in ("sha256", "size")) or asset["url"] != f"{ORIGIN}/{receipt['archive']}":
            raise RuntimeError("Signed QA catalog does not bind the matching official artifact")
        signature = files["/" + name + ".minisig"].decode()
        if f"trusted comment: file={name} sourceSha={receipt['sourceSha']}" not in signature.splitlines():
            raise RuntimeError("Signed catalog source identity differs from the native QA binary")
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
    files = fixture_files(Path(os.environ["QA_SIGNED_MODULE_ROOT"]), receipt)
    ctx.module_marketplace = Origin(files, Path(ctx.case_dir) / "module-marketplace-requests.json")
    ctx.values.update(module_marketplace_url=f"{ORIGIN}/modules.json", module_marketplace_bad_url=f"{ORIGIN}/modules-bad.json",
                      module_marketplace_older_url=f"{ORIGIN}/modules-older.json")


def teardown(ctx):
    origin = getattr(ctx, "module_marketplace", None)
    if origin:
        origin.close()
