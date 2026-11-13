"""Real loopback origin/proxies plus hostile local HTML for viewer boundary QA.

Nothing invokes viewer commands or edits product stores. Browser mode seeds VFS
only and never claims native protocol/proxy evidence. Native symlink/junction
setup failure is a failed fixture, not a passing skip.
"""
from __future__ import annotations

import http.client
import json
import os
import select
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from . import platform_workspace_root
from .explorer_files import PNG

TARGETS = {"next": [80, 36], "external": [80, 82], "spoof-invalid": [80, 128],
           "spoof-valid": [80, 174], "slow": [80, 220], "security": [80, 266]}
PHASES = ("default", "custom", "none", "invalid", "security", "scripts", "slow")


def page(phase: str, origin: str, nonce: str) -> str:
    links = f'''<a id="next" href="next.html">Next local page</a>
<a id="external" href="https://qa-external.invalid/{nonce}">External</a>
<button id="spoof-invalid">Invalid bridge token</button><button id="spoof-valid">Author spoof</button>
<button id="slow">Slow resource</button><button id="security">Security probes</button>'''
    return '''<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="assets/local.css"><script src="assets/local.js"></script>
<style>html,body{margin:0;background:#fff;color:#111}a,button{position:fixed;left:8px;width:144px;height:36px;box-sizing:border-box;display:flex;align-items:center;justify-content:center}#next{top:18px}#external{top:64px}#spoof-invalid{top:110px}#spoof-valid{top:156px}#slow{top:202px}#security{top:248px}#pixel{position:fixed;left:180px;top:20px}#resource{position:fixed;left:180px;top:60px}</style>
</head><body>''' + links + f'''<img id="pixel" src="assets/pixel.png"><span id="resource">HTML network fixture</span>
<script>
const phase={json.dumps(phase)}, endpoint={json.dumps(origin)}, nonce={json.dumps(nonce)};
const marker=(name,value)=>console.log("HTML_QA "+name+" "+String(value));
const token=location.pathname.split('/')[1];
const root=location.href.slice(0,location.href.lastIndexOf('/')+1);
async function request(path,label){{try{{const response=await fetch(path);const text=await response.text();marker(label,response.status+" "+text.slice(0,80))}}catch(error){{marker(label,"BLOCKED")}}}}
addEventListener('load',async()=>{{
 marker("READY",phase);marker("LOCAL",getComputedStyle(document.getElementById('resource')).color+" "+document.getElementById('pixel').naturalWidth+" "+String(window.HTML_QA_LOCAL_JS));
 try{{void parent.document.title;marker("PARENT","BAD")}}catch(_){{marker("PARENT","BLOCKED")}}
 marker("IPC_GLOBAL",typeof window.__TAURI_INTERNALS__);
 await request(endpoint+"/"+phase+"/probe.json?nonce="+nonce,"FETCH");
 marker("SETTLED",phase);
}});
document.getElementById('slow').onclick=()=>request(endpoint+'/slow/stream?nonce='+nonce,'SLOW');
document.getElementById('spoof-invalid').onclick=()=>{{parent.postMessage({{type:'taomni-html-preview',token:'wrong-token',kind:'external',href:'https://qa-spoof-invalid.invalid/'+nonce}},'*');marker('SPOOF_INVALID','SENT')}};
document.getElementById('spoof-valid').onclick=()=>{{
 let actual=token;const text=Array.from(document.scripts).map(s=>s.textContent).join(' ');const match=text.match(/const token = ["']([^"']+)["']/)||text.match(/token:["']([^"']+)["']/);if(match)actual=match[1];
 parent.postMessage({{type:'taomni-html-preview',token:actual,kind:'external',href:'https://qa-author-spoof.invalid/'+nonce}},'*');marker('SPOOF_VALID','SENT');
}};
document.getElementById('security').onclick=async()=>{{
 const tests=[['TRAVERSAL',root+'%2e%2e/outside-secret.txt'],['LAYERED',root+'%252e%252e/outside-secret.txt'],['SYMLINK',root+'escape/secret.txt'],['CROSS_TOKEN',root.replace('/'+token+'/','/00000000000000000000000000000000/')+'security.html'],['IPC','ipc://localhost/viewer_read_bytes']];
 for(const [label,url] of tests)await request(url,label);marker('SECURITY','DONE');
}};
</script></body></html>'''


class Servers:
    def __init__(self, directory: Path, nonce: str):
        self.directory, self.nonce = directory, nonce
        self.log = directory / "html-network-server.jsonl"
        self.log.write_text("", encoding="utf-8")
        self.lock, self.stopping = threading.Lock(), threading.Event()
        self.servers, self.connections = [], set()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def emit(self, event, **fields):
                owner.record(event, route=self.server.route, path=urlsplit(self.path).path, **fields)

            def do_GET(self):
                target = urlsplit(self.path)
                self.emit("request", absolute=bool(target.scheme), auth=bool(self.headers.get("Authorization")),
                          cookie=bool(self.headers.get("Cookie")), forwarded=self.headers.get("X-QA-Route", "direct"))
                with owner.lock:
                    owner.connections.add(self.connection)
                try:
                    if self.server.route != "origin":
                        if target.scheme != "http" or target.hostname != "127.0.0.1" or target.port != owner.origin_port:
                            self.send_error(403, "fixture proxy only forwards its own origin")
                            return
                        upstream = http.client.HTTPConnection("127.0.0.1", owner.origin_port, timeout=5)
                        try:
                            upstream.request("GET", target.path + ("?" + target.query if target.query else ""),
                                             headers={"X-QA-Route": self.server.route, "Connection": "close"})
                            response = upstream.getresponse()
                            self.send_response(response.status)
                            for key, value in response.getheaders():
                                if key.lower() in ("content-type", "content-length", "cache-control"):
                                    self.send_header(key, value)
                            self.send_header("Connection", "close")
                            self.end_headers()
                            while not owner.stopping.is_set():
                                chunk = response.read(1024)
                                if not chunk:
                                    break
                                self.wfile.write(chunk)
                                self.wfile.flush()
                            self.emit("completed")
                        except (OSError, http.client.HTTPException):
                            self.emit("cancelled")
                        finally:
                            upstream.close()
                        return
                    if target.path == "/slow/stream":
                        self.send_response(200)
                        self.send_header("Content-Type", "text/plain")
                        self.send_header("Content-Length", str(16 * 1024 * 1024))
                        self.send_header("Connection", "close")
                        self.end_headers()
                        self.emit("stream-started")
                        while not owner.stopping.wait(.05):
                            if select.select([self.connection], [], [], 0)[0]:
                                try:
                                    if not self.connection.recv(1, socket.MSG_PEEK):
                                        self.emit("cancelled")
                                        return
                                except OSError:
                                    self.emit("cancelled")
                                    return
                            self.wfile.write(b"x" * 1024)
                            self.wfile.flush()
                        return
                    body = json.dumps({"nonce": owner.nonce, "route": self.headers.get("X-QA-Route", "direct"), "path": target.path}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(body)
                    self.emit("completed")
                except OSError:
                    self.emit("cancelled")
                finally:
                    self.close_connection = True
                    with owner.lock:
                        owner.connections.discard(self.connection)

            def do_CONNECT(self):
                self.emit("forbidden-connect")
                self.send_error(403, "No TLS tunnel in local fixture")

        for route in ("origin", "app", "custom"):
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            server.daemon_threads, server.route = True, route
            self.servers.append(server)
        self.origin_port = self.servers[0].server_port
        self.origin = f"http://127.0.0.1:{self.origin_port}"
        self.threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in self.servers]
        for thread in self.threads:
            thread.start()
        self.invalid = socket.socket()
        self.invalid.bind(("127.0.0.1", 0))  # owned, deliberately not listening

    def record(self, event, **fields):
        with self.lock, self.log.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"event": event, "time": time.monotonic(), **fields}) + "\n")

    def close(self):
        self.stopping.set()
        with self.lock:
            connections = list(self.connections)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join(5)
        self.invalid.close()


def proxy(port):
    return dict(enabled=True, mode="manual", kind="http", host="127.0.0.1", port=port,
                username="", password_ref="", session_id="")


def setup(ctx):
    try:
        _setup(ctx)
    except Exception:
        teardown(ctx)
        raise


def _setup(ctx):
    platform_workspace_root.setup(ctx)
    native = ctx.cfg["app"]["mode"] == "native"
    ctx.case_dir.mkdir(parents=True, exist_ok=True)
    nonce = uuid4().hex
    servers = Servers(ctx.case_dir, nonce)
    ctx.html_network_servers = servers
    root = ctx.values["platform_workspace_root"] + "/html-network-" + nonce[:10]
    files = {phase + ".html": page(phase, servers.origin, nonce).encode() for phase in PHASES}
    files.update({"next.html": b"<!doctype html><p>Next local page</p><script>console.log('HTML_QA NEXT READY')</script>",
                  "assets/local.css": b"#resource{color:rgb(12,34,56)}", "assets/local.js": b"window.HTML_QA_LOCAL_JS='loaded';",
                  "assets/pixel.png": PNG})
    symlink_kind = "not-applicable-browser-vfs"
    previous, proxy_path = None, None
    if native:
        for relative, data in files.items():
            target = Path(root) / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        (Path(root).parent / "outside-secret.txt").write_text("HTML_QA_OUTSIDE_SECRET_" + nonce, encoding="utf-8")
        outside = Path(root).parent / ("html-outside-" + nonce[:10])
        outside.mkdir()
        (outside / "secret.txt").write_text("HTML_QA_OUTSIDE_SECRET_" + nonce, encoding="utf-8")
        link = Path(root) / "escape"
        try:
            link.symlink_to(outside, target_is_directory=True)
            symlink_kind = "directory-symlink"
        except OSError as error:
            if os.name != "nt":
                raise RuntimeError(f"HTML symlink fixture could not be created: {error}") from error
            result = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True, text=True)
            if result.returncode or not link.is_dir():
                raise RuntimeError("Windows HTML boundary requires a real symlink or junction; setup failed, not skipped: " + result.stderr)
            symlink_kind = "windows-directory-junction"
        from tauri_webdriver import native_isolation_env
        from native_build import QA_APP_ID
        expected = native_isolation_env(Path(ctx.report_root).resolve())
        if any(os.environ.get(key) != value for key, value in expected.items()):
            raise RuntimeError("HTML network fixture requires current-run QA isolation")
        config = Path(expected.get("NEWMOB_CONFIG_DIR") or expected["XDG_CONFIG_HOME"])
        if expected.get("NEWMOB_CONFIG_DIR"):
            config /= QA_APP_ID
        proxy_path = config / "taomni" / "proxy.json"
        if not proxy_path.resolve().is_relative_to(Path(ctx.report_root).resolve()):
            raise RuntimeError("HTML proxy fixture escaped QA profile")
        previous = proxy_path.read_bytes() if proxy_path.exists() else None
        proxy_path.parent.mkdir(parents=True, exist_ok=True)
        proxy_path.write_text(json.dumps(proxy(servers.servers[1].server_port)), encoding="utf-8")
    else:
        ctx.page.evaluate("""async ({root,files})=>{const vfs=await import('/src/stubs/localVfs.ts');await vfs.vfsMkdir(root);await vfs.vfsMkdir(root+'/assets');for(const [name,bytes]of Object.entries(files))await vfs.vfsWriteBytes(root+'/'+name,new Uint8Array(bytes).buffer)}""",
                          {"root": root, "files": {name: list(data) for name, data in files.items()}})
    ctx.html_network_proxy_previous, ctx.html_network_proxy_path = previous, proxy_path
    ctx.values.update(html_network_root=root, html_network_origin=servers.origin,
                      html_network_log=str(servers.log), html_network_custom_port=str(servers.servers[2].server_port),
                      html_network_invalid_port=str(servers.invalid.getsockname()[1]), html_network_nonce=nonce)
    manifest = dict(schema="qa.html-network.v1", mode="native" if native else "browser", root=root,
                    nonce=nonce, origin=servers.origin, targets=TARGETS, symlinkKind=symlink_kind,
                    proxyPath=str(proxy_path) if proxy_path else None, serverLog=str(servers.log))
    (ctx.case_dir / "html-network-fixture.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def teardown(ctx):
    servers = getattr(ctx, "html_network_servers", None)
    if servers:
        servers.close()
    path = getattr(ctx, "html_network_proxy_path", None)
    if path:
        previous = ctx.html_network_proxy_previous
        if previous is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(previous)
    platform_workspace_root.teardown(ctx)
