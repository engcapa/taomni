"""Real ClickHouse server leases for hosted Linux, macOS and Windows jobs.

Windows runs the same pinned Linux binary inside an isolated WSL2 distribution.
The application still runs in Windows/WebView2 and uses the real TCP protocol.
No shared database, mock server, public listening socket or persisted password.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import urllib.request
from xml.sax.saxutils import escape

VERSION = "25.8.12.129"
BASE = f"https://github.com/ClickHouse/ClickHouse/releases/download/v{VERSION}-lts"
PACKAGES = {
    "Darwin": ("clickhouse-macos-aarch64", "541b149c0b73c44524cf3aff38541697736de266b36b6233811451a7922ee588"),
    "Linux": (f"clickhouse-common-static-{VERSION}-amd64.tgz", "9fd023ffc2446ba00d817bd8cfadfbfd6d161b5710e0a8c4ab5e7a76f8a84b39"),
}
ROOTFS_URL = "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.3-base-amd64.tar.gz"
ROOTFS_SHA = "6bc2cde3930ad088b3bb46fa45279e96d25bc3810f209850ecbe4722711874f9"


def download(url, destination, expected):
    """Publish a package only after checking the pinned upstream SHA256."""
    if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() == expected:
        return
    partial = destination.with_suffix(destination.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as out:
        shutil.copyfileobj(response, out)
    if hashlib.sha256(partial.read_bytes()).hexdigest() != expected:
        partial.unlink(missing_ok=True)
        raise RuntimeError("ClickHouse fixture package checksum mismatch")
    partial.replace(destination)


def install():
    from ci_services import command
    root = Path(os.environ["RUNNER_TEMP"]) / "qa-clickhouse-package"
    root.mkdir(exist_ok=True)
    system = platform.system()
    name, digest = PACKAGES["Darwin" if system == "Darwin" else "Linux"]
    archive = root / name
    download(f"{BASE}/{name}", archive, digest)
    if system == "Windows":
        download(ROOTFS_URL, root / "rootfs.tar.gz", ROOTFS_SHA)
        command(["wsl.exe", "--update", "--web-download"])
    elif system == "Darwin":
        archive.chmod(0o755)
    else:
        with tarfile.open(archive) as bundle:
            member = bundle.getmember(f"clickhouse-common-static-{VERSION}/usr/bin/clickhouse")
            with bundle.extractfile(member) as source, (root / "clickhouse").open("wb") as out:
                shutil.copyfileobj(source, out)
        (root / "clickhouse").chmod(0o755)
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as stream:
        stream.write(f"QA_CLICKHOUSE_PACKAGE={root.as_posix()}\n")


def server_config(path, native_port, http_port, password):
    digest = hashlib.sha256(password.encode()).hexdigest()
    return f"""<clickhouse>
<logger><level>warning</level><console>true</console></logger>
<path>{escape(str(path))}/data/</path><tmp_path>{escape(str(path))}/tmp/</tmp_path>
<user_files_path>{escape(str(path))}/user_files/</user_files_path>
<listen_host>127.0.0.1</listen_host><tcp_port>{native_port}</tcp_port><http_port>{http_port}</http_port>
<max_connections>128</max_connections><max_thread_pool_size>64</max_thread_pool_size>
<background_pool_size>16</background_pool_size><background_schedule_pool_size>4</background_schedule_pool_size>
<mark_cache_size>16777216</mark_cache_size><uncompressed_cache_size>8388608</uncompressed_cache_size>
<profiles><default><max_threads>2</max_threads><max_memory_usage>536870912</max_memory_usage>
<load_balancing>random</load_balancing></default></profiles>
<users><qa><password_sha256_hex>{digest}</password_sha256_hex>
<networks><ip>127.0.0.1</ip></networks><profile>default</profile><quota>default</quota>
<access_management>1</access_management></qa></users>
<quotas><default><interval><duration>3600</duration><queries>0</queries><errors>0</errors>
<result_rows>0</result_rows><read_rows>0</read_rows><execution_time>0</execution_time></interval></default></quotas>
</clickhouse>"""


def start(services):
    from ci_services import command, free_port, retry, secret
    from clickhouse_driver import Client
    package = Path(os.environ["QA_CLICKHOUSE_PACKAGE"])
    password = secret("QA_CLICKHOUSE_PASSWORD")
    port, http_port = free_port(), free_port()
    while port == http_port:
        http_port = free_port()
    system = platform.system()
    directory = services.private / "clickhouse"
    directory.mkdir()
    if system == "Windows":
        distro = services.namespace + "-clickhouse"
        services.cleanup_command(["wsl.exe", "--unregister", distro])
        command(["wsl.exe", "--import", distro, str(directory / "wsl"), str(package / "rootfs.tar.gz"), "--version", "2"])
        prefix = ["wsl.exe", "--distribution", distro, "--user", "root", "--exec"]
        # Copy the executable into ext4; ClickHouse uses mmap and must not run
        # its data directory on a Windows/DrvFS volume.
        mounted = command([*prefix, "wslpath", "-u", str(package)]).replace("\x00", "").strip()
        command([*prefix, "tar", "-xzf", f"{mounted}/{PACKAGES['Linux'][0]}", "-C", "/tmp"])
        binary = f"/tmp/clickhouse-common-static-{VERSION}/usr/bin/clickhouse"
        config = server_config("/tmp/qa-clickhouse", port, http_port, password)
        # stdin carries only a password hash, never a plaintext credential.
        command([*prefix, "sh", "-c", "mkdir -p /tmp/qa-clickhouse && cat > /tmp/qa-clickhouse/config.xml"], input=config)
        process = services.start_process([*prefix, binary, "server", "--config-file=/tmp/qa-clickhouse/config.xml"], "clickhouse")
    else:
        binary = package / ("clickhouse-macos-aarch64" if system == "Darwin" else "clickhouse")
        config_path = directory / "config.xml"
        config_path.write_text(server_config(directory, port, http_port, password), encoding="utf-8")
        config_path.chmod(0o600)
        process = services.start_process([binary, "server", f"--config-file={config_path}"], "clickhouse")

    def probe():
        if process.poll() is not None:
            raise RuntimeError("ClickHouse server exited; see clickhouse.log")
        client = Client(host="127.0.0.1", port=port, user="qa", password=password,
                        connect_timeout=3, send_receive_timeout=5)
        try:
            if client.execute("SELECT 42, toUInt64(18446744073709551615), CAST(NULL AS Nullable(String))") != [(42, 18446744073709551615, None)]:
                raise RuntimeError("ClickHouse native value roundtrip differs")
            client.execute("CREATE DATABASE IF NOT EXISTS qa_session")
            client.execute("CREATE TABLE IF NOT EXISTS qa_session.fixture (id UInt64, value Nullable(String)) ENGINE=Memory")
            client.execute("TRUNCATE TABLE qa_session.fixture")
            client.execute("INSERT INTO qa_session.fixture VALUES", [(1, "fixture-ready"), (2, None)])
            if client.execute("SELECT value FROM qa_session.fixture ORDER BY id") != [("fixture-ready",), (None,)]:
                raise RuntimeError("ClickHouse native DDL/DML roundtrip differs")
        finally:
            client.disconnect()
    retry(probe)
    # Also authenticate the HTTP endpoint: the protocol-switch case uses both.
    request = urllib.request.Request(f"http://127.0.0.1:{http_port}/", data=b"SELECT 42",
                                     headers={"X-ClickHouse-User": "qa", "X-ClickHouse-Key": password})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
        if response.read().strip() != b"42":
            raise RuntimeError("ClickHouse HTTP readiness differs")
    services.config["clickhouse"] = {"host": "127.0.0.1", "port": port, "http_port": http_port,
        "user": "qa", "database": "qa_session", "password": "${env.QA_CLICKHOUSE_PASSWORD}"}
    return {"version": VERSION, "native_query": True, "http_query": True, "ddl_dml": True,
            "port": port, "http_port": http_port, "runtime": "wsl2" if system == "Windows" else "host"}
