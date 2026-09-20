"""Install pinned Java tooling, prove LSP initialization, warm offline projects."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import queue
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
import zipfile

import yaml
from qa_ui_auto.ci import write_json


def download(spec, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(spec["url"], destination)
    if hashlib.sha256(destination.read_bytes()).hexdigest() != spec["sha256"]:
        destination.unlink()
        raise RuntimeError("tool archive checksum mismatch: " + spec["url"])


def checked(command, cwd=None):
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=300)
    if result.returncode:
        raise RuntimeError(f"{command[0]} failed: {result.stdout[-2000:]} {result.stderr[-2000:]}")
    return (result.stdout + result.stderr).strip()


def lsp_probe(home, root):
    """Use the same architecture-specific Eclipse config as the app launcher."""
    suffix = {"Linux": "linux", "Darwin": "mac", "Windows": "win"}[platform.system()]
    if platform.machine().lower() in {"arm64", "aarch64"}:
        suffix += "_arm"
    config = home / ("config_" + suffix)
    if not config.is_dir():
        raise RuntimeError(f"JDTLS configuration unavailable for {platform.machine()}: {config}")
    launcher = next((home / "plugins").glob("org.eclipse.equinox.launcher_*.jar"))
    argv = [shutil.which("java"), "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4", "-Declipse.product=org.eclipse.jdt.ls.core.product",
            "-Xmx1G", "--add-modules=ALL-SYSTEM", "--add-opens", "java.base/java.util=ALL-UNNAMED",
            "--add-opens", "java.base/java.lang=ALL-UNNAMED", "-jar", str(launcher),
            "-configuration", str(config), "-data", str(root / "probe-workspace")]
    messages = queue.Queue()
    with (root / "jdtls-stderr.log").open("wb") as log:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
        def read():
            try:
                while True:
                    headers = {}
                    while True:
                        line = process.stdout.readline()
                        if not line:
                            raise EOFError("JDTLS stdout closed")
                        if line == b"\r\n":
                            break
                        key, value = line.decode().split(":", 1)
                        headers[key.lower()] = value.strip()
                    data = process.stdout.read(int(headers["content-length"]))
                    messages.put(json.loads(data))
            except Exception as exc:
                messages.put(exc)
        threading.Thread(target=read, daemon=True).start()
        def send(value):
            data = json.dumps({"jsonrpc": "2.0", **value}).encode()
            process.stdin.write(f"Content-Length: {len(data)}\r\n\r\n".encode() + data)
            process.stdin.flush()
        try:
            send({"id": 1, "method": "initialize", "params": {"processId": os.getpid(),
                  "rootUri": root.as_uri(), "capabilities": {}, "workspaceFolders": []}})
            end = time.monotonic() + 180
            while True:
                value = messages.get(timeout=max(1, end-time.monotonic()))
                if isinstance(value, Exception):
                    raise value
                if value.get("id") == 1:
                    if "error" in value or not value.get("result", {}).get("capabilities"):
                        raise RuntimeError(f"JDTLS initialize rejected: {value}")
                    return sorted(value["result"]["capabilities"])
                if time.monotonic() > end:
                    raise RuntimeError("JDTLS initialize timeout")
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def warm_projects(root, capabilities):
    from qa_ui_auto.fixtures import java25_projects as projects
    mvn = shutil.which("mvn")
    gradle = projects._gradle_binary()
    if not mvn or not gradle:
        raise RuntimeError("Maven and Gradle must be installed before Java fixtures")
    receipts = []
    if "java25" in capabilities:
        maven, gradle_root = root / "warm-maven25", root / "warm-gradle25"
        for directory, relative, content in (
            (maven, "pom.xml", projects.MAVEN_POM),
            (maven, "src/main/java/com/example/app/App.java", projects.APP_JAVA),
            (gradle_root, "settings.gradle", projects.GRADLE_SETTINGS),
            (gradle_root, "build.gradle", projects.GRADLE_BUILD),
            (gradle_root, "src/main/java/org/example/gradle/GradleApp.java", projects.GRADLE_APP_JAVA),
        ):
            projects._write(directory, relative, content)
        for command, directory in (([mvn, "-q", "-DskipTests", "package"], maven),
                                   ([gradle, "--no-daemon", "clean", "build"], gradle_root),
                                   ([mvn, "-q", "-o", "-DskipTests", "package"], maven),
                                   ([gradle, "--offline", "--no-daemon", "clean", "build"], gradle_root)):
            receipts.append(projects._run_build(command, directory))
    source = Path("src/components/editor/workspace/__fixtures__/jdtls/projects/maven-single")
    project = root / "warm-maven-single"
    project.mkdir(parents=True, exist_ok=True)
    # The editor fixture intentionally contains incomplete completion targets.
    # Resolve its POM dependencies/plugins without compiling those broken inputs.
    shutil.copy2(source / "pom.xml", project / "pom.xml")
    checked([mvn, "-q", "dependency:go-offline", "package"], cwd=project)
    write_json(root / "warmup.json", {"java25": receipts, "maven_single": "POM dependencies/plugins cached; editor sources intentionally incomplete"})


def prepare_java(root, capabilities):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    specs = yaml.safe_load(Path("qa-ui-auto-tests/ci/toolchains.yaml").read_text(encoding="utf-8"))
    base = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / "taomni-qa-java"
    base.mkdir(parents=True, exist_ok=True)
    home = base / "jdtls"
    home.mkdir(exist_ok=True)
    archive = base / "jdtls.tar.gz"
    download(specs["jdtls"], archive)
    with tarfile.open(archive) as bundle:
        bundle.extractall(home, filter="data")
    os.environ["JDTLS_HOME"] = str(home)
    os.environ["PATH"] = str(home / "bin") + os.pathsep + os.environ["PATH"]
    if platform.system() == "Windows":
        # Taomni resolves this path and builds a Java command directly on Windows.
        (home / "bin/jdtls.cmd").write_text('@echo off\r\npython "%~dp0jdtls.py" %*\r\n')
    else:
        (home / "bin/jdtls").chmod(0o755)
    if "java-bundles" in capabilities:
        for name, env in (("java-debug", "QA_JAVA_DEBUG_BUNDLE"), ("java-test", "QA_JAVA_TEST_BUNDLE")):
            spec = specs[name]
            archive = base / (name + ".vsix")
            download(spec, archive)
            extracted = base / name
            with zipfile.ZipFile(archive) as bundle:
                bundle.extractall(extracted)
            server = extracted / "extension/server"
            if not list(server.glob("*.jar")):
                raise RuntimeError(f"{name} archive lacks complete server bundle")
            os.environ[env] = str(server)
            # Automatic bundle-discovery cases need the normal editor install layout.
            # Only the disposable hosted HOME is allowed for this integration path.
            if os.environ.get("GITHUB_ACTIONS") == "true":
                target = Path.home() / ".vscode/extensions" / f"vscjava.vscode-{name}-{spec['version']}"
                shutil.copytree(extracted / "extension", target, dirs_exist_ok=True)
    facts = {"java": checked([shutil.which("java"), "-version"]), "architecture": platform.machine(),
             "versions": {k: v["version"] for k, v in specs.items() if isinstance(v, dict)},
             "lsp_capabilities": lsp_probe(home, root)}
    write_json(root / "readiness.json", facts)
    warm_projects(root, capabilities)
    return facts


if __name__ == "__main__":
    prepare_java(Path("qa-ui-auto-report/java-probe"), ["java", "java25", "java-bundles"])
