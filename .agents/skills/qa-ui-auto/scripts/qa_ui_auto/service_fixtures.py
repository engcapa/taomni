"""Runner-owned local SSH and MySQL service fixtures.

These services are opt-in through the top-level ``fixtures`` config section.
They are started once per runner invocation, before browser workers or the
native harness, and are always removed when the run exits.

The MySQL readiness check deliberately uses a separate MySQL client container
against the mapped host port.  A TCP connect alone only proves that something
is listening; the client query proves the configured user, password, database,
and MySQL protocol are usable by the native app.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

from . import config as cfg_mod


SSH_CONTAINER_NAME = "qa-ui-auto-sshd"
MYSQL_CONTAINER_NAME = "qa-ui-auto-mysql"
DEFAULT_SSH_IMAGE = "linuxserver/openssh-server:latest"
DEFAULT_MYSQL_IMAGE = "mysql:8.4"
DEFAULT_STARTUP_TIMEOUT_SEC = 120


class ServiceFixtureError(RuntimeError):
    """A configured local service could not be started or made ready."""


def _docker_available() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        subprocess.run(
            ["docker", "info"],
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
        )
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def _run(
    args: list[str],
    *,
    check: bool = False,
    timeout: float = 60,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            args,
            check=check,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except OSError as exc:
        raise ServiceFixtureError(f"failed to execute {args[0]}: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ServiceFixtureError(f"command timed out: {args[0]}") from exc


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _resolve_setting(
    cfg: dict,
    env: dict[str, str],
    value: Any,
    *,
    name: str,
) -> Any:
    if value is None:
        return None
    try:
        return cfg_mod.resolve(value, cfg=cfg, env=env)
    except KeyError as exc:
        raise ServiceFixtureError(
            f"local service setting {name} references an unset value: {exc}"
        ) from exc


def _required(value: Any, *, name: str) -> str:
    if value is None or not str(value).strip():
        raise ServiceFixtureError(
            f"local service setting {name} is required when its fixture is enabled"
        )
    return str(value)


def _remove_container(name: str) -> None:
    _run(["docker", "rm", "-f", name], timeout=30)


def _wait_for_tcp(
    host: str,
    port: int,
    *,
    timeout_sec: float,
    banner_prefix: bytes | None = None,
) -> None:
    deadline = time.monotonic() + timeout_sec
    last_error: OSError | None = None
    last_banner: bytes | None = None
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=3) as sock:
                if banner_prefix is not None:
                    sock.settimeout(3)
                    banner = sock.recv(128)
                    if not banner.startswith(banner_prefix):
                        # A freshly published Docker port can accept a TCP
                        # connection before sshd has completed its first
                        # protocol handshake. Treat an empty/foreign first
                        # read as a transient readiness state and reconnect.
                        last_banner = banner[:32]
                        time.sleep(0.2)
                        continue
                return
        except OSError as exc:
            last_error = exc
        time.sleep(1)
    detail = f": {last_error}" if last_error else ""
    if last_banner is not None:
        detail += f"; last banner={last_banner!r}"
    raise ServiceFixtureError(
        f"local service {host}:{port} did not become reachable within "
        f"{timeout_sec:.0f}s{detail}"
    )


def start_sshd(
    *,
    port: int,
    user: str,
    password: str,
    image: str = DEFAULT_SSH_IMAGE,
    timeout_sec: float = DEFAULT_STARTUP_TIMEOUT_SEC,
) -> str:
    """Start and verify the disposable SSH/SFTP Docker fixture."""
    _remove_container(SSH_CONTAINER_NAME)
    result = _run(
        [
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            SSH_CONTAINER_NAME,
            "-p",
            f"127.0.0.1:{port}:2222",
            "-e",
            f"USER_NAME={user}",
            "-e",
            "PASSWORD_ACCESS=true",
            "-e",
            f"USER_PASSWORD={password}",
            image,
        ],
        check=False,
        timeout=120,
    )
    if result.returncode != 0:
        raise ServiceFixtureError(
            f"failed to start SSH fixture container {SSH_CONTAINER_NAME}: "
            f"{result.stderr.strip()[-500:]}"
        )
    try:
        _wait_for_tcp(
            "127.0.0.1",
            port,
            timeout_sec=timeout_sec,
            banner_prefix=b"SSH-",
        )
    except Exception:
        _remove_container(SSH_CONTAINER_NAME)
        raise
    return SSH_CONTAINER_NAME


def start_mysql(
    *,
    port: int,
    user: str,
    password: str,
    root_password: str,
    database: str,
    image: str = DEFAULT_MYSQL_IMAGE,
    timeout_sec: float = DEFAULT_STARTUP_TIMEOUT_SEC,
) -> str:
    """Start and verify the disposable MySQL Docker fixture."""
    _remove_container(MYSQL_CONTAINER_NAME)
    result = _run(
        [
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            MYSQL_CONTAINER_NAME,
            "-p",
            f"127.0.0.1:{port}:3306",
            "-e",
            f"MYSQL_ROOT_PASSWORD={root_password}",
            "-e",
            f"MYSQL_DATABASE={database}",
            "-e",
            f"MYSQL_USER={user}",
            "-e",
            f"MYSQL_PASSWORD={password}",
            image,
        ],
        check=False,
        timeout=120,
    )
    if result.returncode != 0:
        raise ServiceFixtureError(
            f"failed to start MySQL fixture container {MYSQL_CONTAINER_NAME}: "
            f"{result.stderr.strip()[-500:]}"
        )
    try:
        _wait_for_mysql(
            port=port,
            user=user,
            password=password,
            database=database,
            image=image,
            container_name=MYSQL_CONTAINER_NAME,
            timeout_sec=timeout_sec,
        )
    except Exception:
        _remove_container(MYSQL_CONTAINER_NAME)
        raise
    return MYSQL_CONTAINER_NAME


def stop_container(name: str) -> None:
    """Stop a fixture container without masking the test result."""
    _remove_container(name)


def _mysql_probe(
    *,
    port: int,
    user: str,
    password: str,
    database: str,
    image: str,
    container_name: str,
) -> subprocess.CompletedProcess[str]:
    # Linux host networking is the same route used by the verified Replit
    # probe: the temporary client reaches the published 127.0.0.1:3306 port.
    # Docker Desktop does not provide the same host-network semantics, so the
    # client shares the MySQL container namespace there and targets 3306.
    if platform.system() == "Linux":
        network_args = ["--network", "host"]
        host = "127.0.0.1"
        client_port = str(port)
    else:
        network_args = ["--network", f"container:{container_name}"]
        host = "127.0.0.1"
        client_port = "3306"

    probe_env = dict(os.environ)
    probe_env["MYSQL_PWD"] = password
    return _run(
        [
            "docker",
            "run",
            "--rm",
            *network_args,
            "--env",
            "MYSQL_PWD",
            image,
            "mysql",
            "--protocol=tcp",
            f"-h{host}",
            f"-P{client_port}",
            f"-u{user}",
            f"-D{database}",
            "--batch",
            "--skip-column-names",
            "-e",
            "SELECT 1;",
        ],
        timeout=30,
        env=probe_env,
    )


def _wait_for_mysql(
    *,
    port: int,
    user: str,
    password: str,
    database: str,
    image: str,
    container_name: str,
    timeout_sec: float,
) -> None:
    deadline = time.monotonic() + timeout_sec
    last_error = "no MySQL client response"
    while time.monotonic() < deadline:
        try:
            _wait_for_tcp("127.0.0.1", port, timeout_sec=2)
            probe = _mysql_probe(
                port=port,
                user=user,
                password=password,
                database=database,
                image=image,
                container_name=container_name,
            )
            if probe.returncode == 0 and probe.stdout.strip().splitlines() == ["1"]:
                return
            last_error = (probe.stderr or probe.stdout).strip()[-500:] or last_error
        except (ServiceFixtureError, OSError) as exc:
            last_error = str(exc)
        time.sleep(2)
    raise ServiceFixtureError(
        f"MySQL fixture {container_name} did not accept a real client query "
        f"within {timeout_sec:.0f}s: {last_error}"
    )


class LocalServiceFixtures:
    """Manage opt-in SSH and MySQL containers for one runner invocation."""

    def __init__(
        self,
        cfg: dict,
        env: dict[str, str],
        *,
        report_root: Path | None = None,
    ) -> None:
        self.cfg = cfg
        self.env = env
        self.report_root = report_root
        self._started: list[str] = []
        self._metadata: dict[str, Any] = {"ssh": None, "mysql": None}

    def __enter__(self) -> "LocalServiceFixtures":
        settings = self.cfg.get("fixtures") or {}
        start_ssh = _as_bool(settings.get("start_local_sshd", False))
        start_mysql = _as_bool(settings.get("start_local_mysql", False))
        if not start_ssh and not start_mysql:
            return self
        if not _docker_available():
            raise ServiceFixtureError(
                "local service fixture is enabled, but Docker is unavailable. "
                "Start Docker or set the corresponding start_local_* option to false."
            )

        try:
            timeout_sec = float(
                settings.get("startup_timeout_sec", DEFAULT_STARTUP_TIMEOUT_SEC)
            )
            if start_ssh:
                self._start_ssh(settings, timeout_sec)
            if start_mysql:
                self._start_mysql(settings, timeout_sec)
            self._write_metadata()
            return self
        except Exception:
            self.close()
            raise

    def __exit__(self, exc_type, exc_value, traceback) -> bool:
        self.close()
        return False

    def close(self) -> None:
        for name in reversed(self._started):
            try:
                stop_container(name)
            except Exception:
                # Fixture cleanup must not replace the product/test result.
                pass
        if self._started:
            self._metadata["cleaned"] = True
            self._write_metadata()
        self._started.clear()

    def _start_ssh(self, settings: dict[str, Any], timeout_sec: float) -> None:
        target = self.cfg.setdefault("ssh", {})
        port = int(settings.get("sshd_port", target.get("port", 2222)))
        user = _required(
            settings.get("sshd_user", target.get("user")),
            name="fixtures.sshd_user",
        )
        raw_password = settings.get("sshd_password", target.get("password"))
        password = _required(
            _resolve_setting(self.cfg, self.env, raw_password, name="fixtures.sshd_password"),
            name="fixtures.sshd_password",
        )
        image = str(settings.get("sshd_image", DEFAULT_SSH_IMAGE))
        name = start_sshd(
            port=port,
            user=user,
            password=password,
            image=image,
            timeout_sec=timeout_sec,
        )
        self._started.append(name)
        self.env.setdefault("QA_SSH_PASSWORD", password)
        target.update({"host": "127.0.0.1", "port": port, "user": user})
        self._metadata["ssh"] = {
            "container": name,
            "image": image,
            "host": "127.0.0.1",
            "port": port,
            "user": user,
        }

    def _start_mysql(self, settings: dict[str, Any], timeout_sec: float) -> None:
        target = self.cfg.setdefault("database", {})
        legacy_target = self.cfg.get("mysql") or {}
        port = int(settings.get("mysql_port", target.get("port", 3306)))
        user = _required(
            settings.get("mysql_user", target.get("user", legacy_target.get("user"))),
            name="fixtures.mysql_user",
        )
        database = _required(
            settings.get(
                "mysql_database",
                target.get("database", legacy_target.get("database", "test")),
            ),
            name="fixtures.mysql_database",
        )
        raw_password = settings.get(
            "mysql_password",
            target.get("password", legacy_target.get("password")),
        )
        password = _required(
            _resolve_setting(self.cfg, self.env, raw_password, name="fixtures.mysql_password"),
            name="fixtures.mysql_password",
        )
        raw_root_password = settings.get("mysql_root_password")
        root_password = _required(
            _resolve_setting(
                self.cfg,
                self.env,
                raw_root_password,
                name="fixtures.mysql_root_password",
            ),
            name="fixtures.mysql_root_password",
        )
        image = str(settings.get("mysql_image", DEFAULT_MYSQL_IMAGE))
        name = start_mysql(
            port=port,
            user=user,
            password=password,
            root_password=root_password,
            database=database,
            image=image,
            timeout_sec=timeout_sec,
        )
        self._started.append(name)
        self.env.setdefault("TAOMNI_TEST_MYSQL_PASSWORD", password)
        target.update({"host": "127.0.0.1", "port": port, "user": user, "database": database})
        if legacy_target:
            legacy_target.update({"host": "127.0.0.1", "port": port, "user": user, "database": database})
        self._metadata["mysql"] = {
            "container": name,
            "image": image,
            "host": "127.0.0.1",
            "port": port,
            "user": user,
            "database": database,
        }

    def _write_metadata(self) -> None:
        if self.report_root is None:
            return
        path = self.report_root / "local-service-fixtures.json"
        path.write_text(
            json.dumps(self._metadata, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
