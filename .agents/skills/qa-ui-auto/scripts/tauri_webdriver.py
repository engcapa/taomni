#!/usr/bin/env python3
"""Minimal WebDriver client for Tauri native E2E via tauri-driver.

This intentionally avoids adding a Node test runner dependency to the skill.
It speaks the small W3C WebDriver subset needed by the qa-ui-auto DSL.
"""
from __future__ import annotations

import base64
import http.client
from contextlib import suppress
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from native_build import QA_APP_ID, verify_identity


ROOT = Path.cwd()


def native_binary(cfg: dict) -> Path:
    explicit = cfg.get("app", {}).get("native_binary")
    if explicit:
        return Path(explicit).expanduser()
    name = "taomni.exe" if platform.system() == "Windows" else "taomni"
    return ROOT / "src-tauri" / "target" / "qa-ui-auto" / "debug" / name


def native_isolation_env(report_root: Path) -> dict[str, str]:
    """Resolve only run-owned roots; never fall back to a user's profile.

    ``dirs`` honors XDG on Linux and is explicitly overridden on macOS, but on
    Windows it resolves Known Folders and ignores ``APPDATA``; Taomni's
    debug-only ``NEWMOB_*`` override is the only effective redirection there
    (src-tauri/src/lib.rs documents the same requirement).  Without those keys
    the QA app wrote to the real ``%APPDATA%\\com.taomni.app.qa``, ``reset_db``
    cleaned a path the app never used, and state leaked across cases.
    """
    root = report_root.resolve()
    paths = {key: root / f"native-app{key}" for key in ("data", "config", "cache")}
    checked = [path for root_path in paths.values() for path in (root_path, root_path / QA_APP_ID)]
    if any(path.resolve() != path for path in checked):
        raise WebDriverError("Native isolation directories must not be symlinks")
    system = platform.system()
    if system == "Linux":
        return {f"XDG_{key.upper()}_HOME": str(path) for key, path in paths.items()}
    if system == "Windows":
        return {
            "APPDATA": str(paths["data"]),
            "LOCALAPPDATA": str(paths["cache"]),
            "NEWMOB_DATA_DIR": str(paths["data"]),
            "NEWMOB_CONFIG_DIR": str(paths["config"]),
            "NEWMOB_CACHE_DIR": str(paths["cache"]),
        }
    if system == "Darwin":
        # macOS `dirs` intentionally ignores XDG variables.  These explicit
        # QA-only overrides are consumed by Taomni's config/cache path helpers
        # while leaving the user's HOME and keychain untouched.
        return {
            "NEWMOB_DATA_DIR": str(paths["data"]),
            "NEWMOB_CONFIG_DIR": str(paths["config"]),
            "NEWMOB_CACHE_DIR": str(paths["cache"]),
        }
    raise WebDriverError("native isolation is unsupported on this OS")


def native_tooling_env(cfg: dict) -> tuple[dict[str, str], dict[str, str]]:
    """Pin the configured tooling JDK in the WebDriver-launched application.

    On Windows the application is a grandchild of tauri-driver and
    msedgedriver. Seeding the renderer's LSP setting does not affect Maven or
    workspace terminals, so the process environment must carry the same JDK.
    """
    configured = cfg.get("app", {}).get("tooling_java_home")
    if not configured:
        return {}, {}
    home = str(Path(str(configured)).expanduser())
    java_bin = str(Path(home) / "bin")
    inherited_path = os.environ.get("PATH", "")
    process_env = {
        "JAVA_HOME": home,
        "PATH": java_bin if not inherited_path else os.pathsep.join((java_bin, inherited_path)),
    }
    evidence = {"JAVA_HOME": home, "PATH_prepend": java_bin}
    return process_env, evidence


def seed_native_tooling_sdk(report_root: Path, java_home: str) -> dict[str, str]:
    """Register the prepared JDK before the isolated QA application starts.

    Process inheritance remains the fallback, but it is not an observable SDK
    selection contract across the Windows tauri-driver/msedgedriver launch
    chain. A run-owned registry gives workspace terminals and build tools the
    same explicit JDK that the native session supplies to JDTLS.
    """
    home = Path(java_home).expanduser()
    executable_name = "java.exe" if platform.system() == "Windows" else "java"
    java = home / "bin" / executable_name
    if not java.is_file():
        raise WebDriverError(f"Configured tooling JDK has no executable: {java}")
    probe = subprocess.run(
        [str(java), "-version"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    output = f"{probe.stderr}\n{probe.stdout}"
    match = re.search(r'version\s+"([^"]+)"', output)
    if probe.returncode != 0 or not match:
        raise WebDriverError(f"Configured tooling JDK version probe failed: {java}")
    version = match.group(1)

    isolation = native_isolation_env(report_root)
    if raw_config := isolation.get("NEWMOB_CONFIG_DIR"):
        config_dir = Path(raw_config) / QA_APP_ID
    else:
        config_dir = Path(isolation["XDG_CONFIG_HOME"])
    registry_path = config_dir / "taomni" / "sdk.json"
    run_root = report_root.resolve()
    if not registry_path.resolve().is_relative_to(run_root):
        raise WebDriverError("Tooling SDK registry must stay inside the native run directory")
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    sdk_id = "qa-prepared-java"
    registry = {
        "schemaVersion": 1,
        "installations": [{
            "id": sdk_id,
            "kind": "java",
            "name": f"QA prepared JDK {version}",
            "location": str(home),
            "executables": {"java": str(java)},
            "version": version,
            "vendor": None,
            "architecture": None,
            "origin": "manual",
            "status": "ready",
            "lastError": None,
            "lastProbedAt": None,
        }],
        "defaults": [{"kind": "java", "sdkId": sdk_id}],
        "bindings": [],
    }
    registry_path.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    return {
        "id": sdk_id,
        "java_home": str(home),
        "java_version": version,
        "registry_path": str(registry_path),
    }


def _tcp_ok(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def _quote_xpath_text(value: str) -> str:
    if "'" not in value:
        return f"'{value}'"
    if '"' not in value:
        return f'"{value}"'
    parts = value.split("'")
    return "concat(" + ", \"'\", ".join(f"'{p}'" for p in parts) + ")"


def selector_strategy(selector: str, *, interactive: bool = False) -> tuple[str, str]:
    """Map common Playwright-ish selectors to WebDriver selector strategies."""
    selector = selector.strip()
    if selector.startswith("xpath="):
        return "xpath", selector[6:]
    if " >> text=" in selector:
        parent_sel, text_part = selector.split(" >> text=", 1)
        text = text_part.strip()
        if (text.startswith('"') and text.endswith('"')) or (
            text.startswith("'") and text.endswith("'")
        ):
            text = text[1:-1]
        q = _quote_xpath_text(text)
        if parent_sel.startswith('[data-testid="') and parent_sel.endswith('"]'):
            testid = parent_sel[14:-2]
            return "xpath", f"//*[@data-testid='{testid}']//*[contains(normalize-space(.), {q}) or contains(@aria-label, {q})]"
        return "xpath", f"//*[contains(normalize-space(.), {q})]"
    if selector.startswith("text="):
        text = selector[5:].strip()
        if (text.startswith('"') and text.endswith('"')) or (
            text.startswith("'") and text.endswith("'")
        ):
            text = text[1:-1]
        q = _quote_xpath_text(text)
        if interactive:
            return "xpath", (
                f"//button[contains(normalize-space(.), {q}) or contains(@aria-label, {q}) or contains(@title, {q})]"
                f"|//*[@role='button' and (contains(normalize-space(.), {q}) or contains(@aria-label, {q}) or contains(@title, {q}))]"
                f"|//a[contains(normalize-space(.), {q}) or contains(@aria-label, {q}) or contains(@title, {q})]"
                f"|//input[contains(@value, {q}) or contains(@aria-label, {q}) or contains(@title, {q})]"
            )
        return "xpath", (
            f"//*[contains(normalize-space(.), {q}) "
            f"or contains(@aria-label, {q}) or contains(@title, {q})]"
        )
    if selector.startswith("role=button"):
        name = ""
        marker = "name="
        if marker in selector:
            raw = selector.split(marker, 1)[1].strip()
            if raw.startswith("[") and raw.endswith("]"):
                raw = raw[1:-1]
            if (raw.startswith('"') and raw.endswith('"')) or (
                raw.startswith("'") and raw.endswith("'")
            ):
                raw = raw[1:-1]
            name = raw
        if name:
            q = _quote_xpath_text(name)
            return "xpath", (
                f"//button[normalize-space(.)={q} or @aria-label={q}]"
                f"|//*[@role='button' and (normalize-space(.)={q} or @aria-label={q})]"
            )
        return "css selector", "button,[role='button']"
    return "css selector", selector


class WebDriverError(RuntimeError):
    pass


class TauriDriverProcess:
    def __init__(self, cfg: dict, report_root: Path):
        webdriver = cfg.get("webdriver") or {}
        self.host = str(webdriver.get("host", "127.0.0.1"))
        self.port = int(webdriver.get("port", 4444))
        self.url = f"http://{self.host}:{self.port}"
        self.proc: subprocess.Popen[str] | None = None
        self.report_root = report_root
        self.application = native_binary(cfg)
        self.command = str(webdriver.get("tauri_driver", "tauri-driver"))
        self.native_driver = webdriver.get("native_driver")
        self.native_port = int(webdriver.get("native_port", 4445))
        self._restart_required = False
        self.startup_timeout = float(webdriver.get("startup_timeout", 20))

    def start(self) -> None:
        if self.host not in ("127.0.0.1", "localhost"):
            raise WebDriverError("Native isolation requires a local driver started by this run")
        if _tcp_ok(self.host, self.port):
            raise WebDriverError(f"Driver port {self.port} is occupied; choose a free port so the driver inherits QA isolation")
        if platform.system() != "Darwin" and (
            self.native_port == self.port or _tcp_ok(self.host, self.native_port)
        ):
            raise WebDriverError(f"Native driver port {self.native_port} must be free and distinct from the driver port")
        out = self.report_root / "tauri-driver.out.log"
        err = self.report_root / "tauri-driver.err.log"
        out.parent.mkdir(parents=True, exist_ok=True)
        if platform.system() == "Darwin":
            # tauri-driver intentionally refuses to run on macOS.  The QA
            # binary contains an opt-in WKWebView bridge which exposes the
            # same W3C subset over this run-owned loopback port.
            if not self.application.is_file():
                raise WebDriverError(f"macOS QA application not found: {self.application}")
            env = dict(os.environ)
            env["TAOMNI_QA_WEBDRIVER_HOST"] = self.host
            env["TAOMNI_QA_WEBDRIVER_PORT"] = str(self.port)
            with out.open("a", encoding="utf-8") as stdout, err.open("a", encoding="utf-8") as stderr:
                self.proc = subprocess.Popen(
                    [str(self.application.resolve())],
                    cwd=ROOT,
                    env=env,
                    stdout=stdout,
                    stderr=stderr,
                    text=True,
                )
        else:
            cmd = [self.command, "--port", str(self.port), "--native-port", str(self.native_port)]
            if self.native_driver:
                cmd += ["--native-driver", str(self.native_driver)]
            with out.open("w", encoding="utf-8") as stdout, err.open("w", encoding="utf-8") as stderr:
                self.proc = subprocess.Popen(cmd, cwd=ROOT, stdout=stdout, stderr=stderr, text=True)
        deadline = time.time() + self.startup_timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise WebDriverError(
                    f"native driver exited early with code {self.proc.returncode}; "
                    f"see {err}"
                )
            # tauri-driver can bind its intermediary port before it has
            # finished spawning WebKitWebDriver/msedgedriver.  Returning on
            # the first socket creates a startup race: the first /session
            # request is forwarded while the native driver is still absent
            # and fails as RemoteDisconnected/connection refused.
            ready = _tcp_ok(self.host, self.port)
            if platform.system() != "Darwin":
                ready = ready and _tcp_ok(self.host, self.native_port)
            if ready:
                return
            time.sleep(0.25)
        raise WebDriverError(f"native driver did not listen on {self.url}")

    def ensure_running(self) -> None:
        """Ensure the per-run driver endpoint is ready for a new session.

        The macOS bridge lives inside the QA application and exits that
        application when a WebDriver session is deleted.  Native cases are
        intentionally isolated one application process at a time, so the
        next case must wait for the old process and listening socket to go
        away before starting a fresh one.
        """
        if platform.system() != "Darwin":
            return

        # The in-process bridge exits the QA application after a WebDriver
        # session is deleted.  A new case must never attach to that old
        # listener while the asynchronous app exit is still in flight.
        if self._restart_required:
            self.stop()
            self._restart_required = False

        if self.proc is not None and self.proc.poll() is None and _tcp_ok(self.host, self.port):
            return

        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)

        deadline = time.time() + self.startup_timeout
        while _tcp_ok(self.host, self.port) and time.time() < deadline:
            time.sleep(0.1)
        if _tcp_ok(self.host, self.port):
            raise WebDriverError(f"native driver port {self.port} did not become available")
        self.start()

    def mark_session_closed(self) -> None:
        """Force the next macOS session to start in a fresh QA process."""
        if platform.system() == "Darwin":
            self._restart_required = True

    def stop(self) -> None:
        if not self.proc:
            return
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)
        self.proc = None


class NativeSession:
    def __init__(self, driver_url: str, application: Path, on_close: Any | None = None):
        self.driver_url = driver_url.rstrip("/")
        self.application = application
        self._on_close = on_close
        self.session_id: str | None = None
        self.deadline = None
        self.transport = "macOS WKWebView bridge" if platform.system() == "Darwin" else "tauri-driver"
        # A local driver must remain reachable when the desktop uses a proxy.
        host = urllib.parse.urlsplit(self.driver_url).hostname
        self._local_endpoint = (urllib.parse.urlsplit(self.driver_url)
                                if host in {"localhost", "127.0.0.1", "::1"} else None)
        self._connection: http.client.HTTPConnection | None = None
        self._open = (urllib.request.build_opener(urllib.request.ProxyHandler({})).open
                      if host in {"localhost", "127.0.0.1", "::1"} else urllib.request.urlopen)

    def request(self, method: str, path: str, payload: dict | None = None) -> Any:
        body = None
        headers = {"Content-Type": "application/json"}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.driver_url}{path}", data=body, headers=headers, method=method
        )
        try:
            timeout = min(120, self.deadline.remaining()) if self.deadline else 120
            if self._local_endpoint and self._local_endpoint.scheme == "http":
                # urllib unconditionally adds Connection: close. Forwarded
                # by tauri-driver, this causes WebKitGTK to reset responses
                # mid-flight. Keep the sequential W3C session on HTTP/1.1.
                if self._connection is None:
                    self._connection = http.client.HTTPConnection(
                        self._local_endpoint.hostname, self._local_endpoint.port, timeout=timeout)
                if self._connection.sock:
                    self._connection.sock.settimeout(timeout)
                self._connection.timeout = timeout
                try:
                    self._connection.request(method, path, body=body, headers=headers)
                    response = self._connection.getresponse()
                    data = response.read().decode("utf-8")
                    if response.status >= 400:
                        raise WebDriverError(f"HTTP {response.status}: {data}")
                except Exception:
                    self._connection.close()
                    self._connection = None
                    # Never retry an action whose delivery is uncertain.
                    raise
            else:
                with self._open(req, timeout=timeout) as r:
                    data = r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            raise WebDriverError(f"HTTP {e.code}: {detail}") from e
        if not data:
            return None
        parsed = json.loads(data)
        value = parsed.get("value", parsed)
        if isinstance(value, dict) and "error" in value:
            raise WebDriverError(value.get("message") or value["error"])
        return value

    def start(self) -> None:
        payload = {
            "capabilities": {
                "alwaysMatch": {
                    "tauri:options": {
                        "application": str(self.application.resolve())
                    }
                }
            }
        }
        if platform.system() == "Windows":
            # The QA app chooses an explicit WebView profile. EdgeDriver must
            # watch that same directory for DevToolsActivePort instead of a
            # separate temporary profile (which causes session init to hang).
            data_root = os.environ.get("NEWMOB_DATA_DIR")
            if not data_root:
                raise WebDriverError("Windows WebView2 session requires the QA data directory")
            payload["capabilities"]["alwaysMatch"]["tauri:options"]["webviewOptions"] = {
                "userDataFolder": str(Path(data_root) / QA_APP_ID / "webview")
            }
        value = self.request("POST", "/session", payload)
        sid = value.get("sessionId") if isinstance(value, dict) else None
        if not sid:
            raise WebDriverError(f"could not create WebDriver session: {value}")
        self.session_id = sid
        # The macOS in-process WKWebView bridge can bind before React has
        # mounted its root, and EdgeDriver can return the WebView2 session
        # while the document is still about:blank (localStorage access is
        # denied there).  Do not let the first native step or storage seed
        # race that navigation; transient evaluation failures are retryable,
        # but the case deadline remains authoritative.
        self.wait_for_app_ready()
        self.install_console_hook()

    def wait_for_app_ready(self, timeout: float = 20.0) -> None:
        """Wait until the QA WebView has a mounted application root."""
        end = time.monotonic() + timeout
        last_error = ""
        while time.monotonic() < end:
            if self.deadline:
                self.deadline.remaining()
            try:
                ready = self.execute(
                    "return document.readyState === 'complete' && "
                    "!!document.querySelector('#root > *');"
                )
            except (WebDriverError, urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
                # The bridge is exposed at page-load time, while WebKit may
                # still be transitioning the document to an evaluable state.
                last_error = str(exc)
            else:
                if ready is True:
                    return
                last_error = "document root is not mounted"

            sleep_for = min(0.1, end - time.monotonic())
            if self.deadline:
                sleep_for = min(sleep_for, self.deadline.remaining())
            if sleep_for > 0:
                time.sleep(sleep_for)
        detail = f": {last_error}" if last_error else ""
        raise WebDriverError(f"native app document did not become ready within {timeout:.1f}s{detail}")

    def close(self) -> None:
        if self.session_id:
            try:
                self.request("DELETE", f"/session/{self.session_id}")
            finally:
                self.session_id = None
                if self._connection:
                    self._connection.close()
                    self._connection = None
                if self._on_close is not None:
                    self._on_close()

    def endpoint(self, suffix: str) -> str:
        if not self.session_id:
            raise WebDriverError("WebDriver session is not started")
        return f"/session/{self.session_id}{suffix}"

    def find(self, selector: str, timeout: float = 10.0,
             *, interactive: bool = False) -> str:
        using, value = selector_strategy(selector, interactive=interactive)
        deadline = time.time() + timeout
        last_error = ""
        while time.time() < deadline:
            if self.deadline:
                self.deadline.remaining()
            try:
                found = self.request(
                    "POST",
                    self.endpoint("/element"),
                    {"using": using, "value": value},
                )
                if isinstance(found, dict):
                    element_id = (
                        found.get("element-6066-11e4-a52e-4f735466cecf")
                        or found.get("ELEMENT")
                    )
                    if element_id:
                        return element_id
            except Exception as e:  # keep polling until timeout
                last_error = str(e)
            time.sleep(0.25)
        raise WebDriverError(f"element not found: {selector} {last_error}".strip())

    def element_path(self, element_id: str, suffix: str = "") -> str:
        return self.endpoint(f"/element/{element_id}{suffix}")

    def click(self, selector: str) -> str:
        for attempt in range(3):
            try:
                element = self.find(selector, interactive=True)
                self.request("POST", self.element_path(element, "/click"), {})
                return f"clicked {selector}"
            except WebDriverError as exc:
                if "stale element reference" in str(exc) and attempt < 2:
                    time.sleep(0.3)
                    continue
                if ("element not interactable" in str(exc) or "element click intercepted" in str(exc)) and attempt < 2:
                    with suppress(Exception):
                        self.execute(
                            f"const el = document.querySelector({json.dumps(selector)});"
                            "if (el) { el.scrollIntoView({block:'center', inline:'center'}); el.click(); }"
                        )
                        return f"clicked {selector}"
                raise
        return f"clicked {selector}"

    def count(self, selector: str) -> int:
        using, value = selector_strategy(selector)
        elements = self.request("POST", self.endpoint("/elements"),
                                {"using": using, "value": value})
        if not isinstance(elements, list):
            raise WebDriverError(f"invalid element list for {selector}: {elements!r}")
        return len(elements)

    def right_click(self, selector: str) -> str:
        return self.pointer_button_click(selector, 2)

    def pointer_button_click(self, selector: str, button: int) -> str:
        # The row can be re-rendered (React replaces the node) between the
        # locator resolution below and the scroll/input dispatch — for example
        # right after a save or when the context menu mounts. A stale element
        # then fails the whole case with a raw driver error, so re-resolve and
        # retry instead of propagating the first stale reference.
        last_stale: WebDriverError | None = None
        for attempt in range(3):
            element = self.find(selector, interactive=True)
            origin = {"element-6066-11e4-a52e-4f735466cecf": element}
            # Scroll only; dispatch the actual context click through W3C input.
            try:
                self.request("POST", self.endpoint("/execute/sync"), {
                    "script": "arguments[0].scrollIntoView({block:'nearest', inline:'nearest'});",
                    "args": [origin],
                })
                self.request("POST", self.endpoint("/actions"), {"actions": [{
                    "type": "pointer", "id": "context-mouse",
                    "parameters": {"pointerType": "mouse"},
                    "actions": [
                        {"type": "pointerMove", "duration": 0, "origin": origin, "x": 0, "y": 0},
                        {"type": "pointerDown", "button": button},
                        {"type": "pointerUp", "button": button},
                    ],
                }]})
            except WebDriverError as exc:
                if "stale element reference" in str(exc) and attempt < 2:
                    last_stale = exc
                    time.sleep(0.3)
                    continue
                raise
            finally:
                # Best-effort: a failed release must not mask the real error or
                # abort a stale-element retry.
                with suppress(WebDriverError):
                    self.request("DELETE", self.endpoint("/actions"))
            return f"pointer button {button} clicked {selector}"
        raise last_stale if last_stale else WebDriverError(
            f"pointer button {button} click failed: {selector}")

    def focus(self, selector: str) -> str:
        """Focus for locator-scoped keys without activating a button/tree row."""
        element = self.find(selector)
        focused = self.request("POST", self.endpoint("/execute/sync"), {
            "script": "arguments[0].focus(); return document.activeElement === arguments[0];",
            "args": [{"element-6066-11e4-a52e-4f735466cecf": element}],
        })
        if focused is not True:
            raise WebDriverError(f"element could not receive focus: {selector}")
        return f"focused {selector}"

    def dblclick(self, selector: str) -> str:
        try:
            element = self.find(selector, interactive=True)
            # Scroll element into center of view first so pointer actions hit the target.
            with suppress(Exception):
                self.execute(
                    f"const el = document.querySelector({json.dumps(selector)});"
                    "if (el) el.scrollIntoView({block:'center', inline:'center'});"
                )
                time.sleep(0.1)
            # Use W3C Actions API so WebKitGTK registers a real double-click.
            rect = self.request("GET", self.element_path(element, "/rect"))
            x = int((rect.get("x", 0) + rect.get("width", 0) / 2)) if isinstance(rect, dict) else 0
            y = int((rect.get("y", 0) + rect.get("height", 0) / 2)) if isinstance(rect, dict) else 0
            self.request(
                "POST",
                self.endpoint("/actions"),
                {
                    "actions": [
                        {
                            "type": "pointer",
                            "id": "mouse",
                            "parameters": {"pointerType": "mouse"},
                            "actions": [
                                {"type": "pointerMove", "duration": 0, "x": x, "y": y, "origin": "viewport"},
                                {"type": "pointerDown", "button": 0},
                                {"type": "pointerUp", "button": 0},
                                {"type": "pause", "duration": 50},
                                {"type": "pointerDown", "button": 0},
                                {"type": "pointerUp", "button": 0},
                            ],
                        }
                    ]
                },
            )
        except Exception as exc:
            if "element not interactable" in str(exc) or "element click intercepted" in str(exc):
                self.execute(
                    f"const el = document.querySelector({json.dumps(selector)});"
                    "if (el) {"
                    "  el.scrollIntoView({block:'center', inline:'center'});"
                    "  el.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true, view: window}));"
                    "}"
                )
            else:
                raise
        return f"double-clicked {selector}"

    def pointer_click(self, selector: str) -> dict[str, int]:
        """Click through W3C pointer actions instead of element /click."""
        element = self.find(selector, interactive=True)
        rect = self.request("GET", self.element_path(element, "/rect"))
        x = int((rect.get("x", 0) + rect.get("width", 0) / 2)) if isinstance(rect, dict) else 0
        y = int((rect.get("y", 0) + rect.get("height", 0) / 2)) if isinstance(rect, dict) else 0
        self.request(
            "POST",
            self.endpoint("/actions"),
            {
                "actions": [
                    {
                        "type": "pointer",
                        "id": "native-pointer",
                        "parameters": {"pointerType": "mouse"},
                        "actions": [
                            {"type": "pointerMove", "duration": 100, "x": x, "y": y, "origin": "viewport"},
                            {"type": "pointerDown", "button": 0},
                            {"type": "pause", "duration": 80},
                            {"type": "pointerUp", "button": 0},
                        ],
                    }
                ]
            },
        )
        return {"x": x, "y": y}

    def pointer_drag(
        self,
        start: dict[str, int],
        end: dict[str, int],
        modifiers: list[str] | None = None,
    ) -> dict[str, dict[str, int]]:
        """Drag between viewport coordinates while holding W3C modifiers."""
        modifier_names = modifiers or []
        modifier_values: list[str] = []
        for name in modifier_names:
            value = self.MODIFIER_MAP.get(name)
            if value is None:
                raise WebDriverError(f"pointer_drag: unknown modifier {name!r}")
            modifier_values.append(value)

        pointer_core = [
            {
                "type": "pointerMove",
                "duration": 100,
                "x": int(start["x"]),
                "y": int(start["y"]),
                "origin": "viewport",
            },
            {"type": "pointerDown", "button": 0},
            {
                "type": "pointerMove",
                "duration": 400,
                "x": int(end["x"]),
                "y": int(end["y"]),
                "origin": "viewport",
            },
            {"type": "pause", "duration": 100},
            {"type": "pointerUp", "button": 0},
        ]
        pointer_actions = (
            [{"type": "pause", "duration": 0} for _ in modifier_values]
            + pointer_core
            + [{"type": "pause", "duration": 0} for _ in modifier_values]
        )
        key_actions: list[dict[str, Any]] = []
        if modifier_values:
            key_actions.extend(
                {"type": "keyDown", "value": value} for value in modifier_values
            )
            key_actions.extend(
                {"type": "pause", "duration": 0}
                for _ in pointer_core
            )
            key_actions.extend(
                {"type": "keyUp", "value": value}
                for value in reversed(modifier_values)
            )

        actions: list[dict[str, Any]] = []
        if key_actions:
            actions.append({"type": "key", "id": "drag-keyboard", "actions": key_actions})
        actions.append({
            "type": "pointer",
            "id": "native-drag-pointer",
            "parameters": {"pointerType": "mouse"},
            "actions": pointer_actions,
        })
        try:
            self.request("POST", self.endpoint("/actions"), {"actions": actions})
        finally:
            # Release any input source left depressed by a failed driver action.
            try:
                self.request("DELETE", self.endpoint("/actions"))
            except (WebDriverError, urllib.error.URLError, OSError):
                pass
        return {
            "start": {"x": int(start["x"]), "y": int(start["y"])},
            "end": {"x": int(end["x"]), "y": int(end["y"])},
        }

    def fill(self, selector: str, text: str) -> str:
        element = self.find(selector)
        contenteditable = self.execute(
            f"const el = document.querySelector({json.dumps(selector)});"
            "return !!el?.isContentEditable;"
        )
        if contenteditable is True:
            # WebKit accepts element /value for contenteditable nodes without
            # dispatching the beforeinput/input events CodeMirror owns. Drive
            # real key actions so the editor creates a normal transaction.
            for _ in range(3):
                self.request("POST", self.element_path(element, "/click"), {})
                focused = self.execute(
                    f"const el = document.querySelector({json.dumps(selector)});"
                    "return !!el && document.activeElement === el;"
                )
                if focused is True:
                    break
                time.sleep(0.1)
            else:
                raise WebDriverError(f"contenteditable did not receive focus: {selector}")
            self.press_combo("Control+a")
            lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
            for index, line in enumerate(lines):
                if index:
                    self.press_combo("Enter")
                if line:
                    self.type_text(line)
            return f"filled contenteditable {selector}"
        if platform.system() == "Darwin":
            # The WKWebView bridge's value endpoint replaces the value using
            # the native DOM setter and React input events without blurring.
            # Its synthetic keyboard adapter cannot perform OS select-all.
            self.request("POST", self.element_path(element, "/value"), {"text": text})
            return f"filled {selector}"
        # WebDriver /clear unfocuses form controls. Blur-committing inputs
        # (path breadcrumbs, rename fields) disappear before /value arrives.
        # Select and replace through keyboard input while retaining focus.
        self.request("POST", self.element_path(element, "/click"), {})
        self.press_combo("Mod+a")
        self.press_combo("Backspace")
        self.type_text(text)
        return f"filled {selector}"

    def send_keys(self, text: str) -> str:
        keys = {
            "Enter": "\ue007",
            "Tab": "\ue004",
            "Escape": "\ue00c",
            "Backspace": "\ue003",
            "Delete": "\ue017",
        }.get(text, text)
        self.request(
            "POST",
            self.endpoint("/actions"),
            {
                "actions": [
                    {
                        "type": "key",
                        "id": "keyboard",
                        "actions": [
                            {"type": "keyDown", "value": ch} for ch in keys
                        ]
                        + [{"type": "keyUp", "value": ch} for ch in keys],
                    }
                ]
            },
        )
        return f"sent keys {text}"

    # W3C key code points for named keys that have no printable character.
    KEY_MAP = {
        "Enter": "\ue007",
        "Tab": "\ue004",
        "Escape": "\ue00c",
        "Space": "\ue00d",
        "Backspace": "\ue003",
        "Delete": "\ue017",
        "ArrowUp": "\ue013",
        "ArrowDown": "\ue015",
        "ArrowLeft": "\ue012",
        "ArrowRight": "\ue014",
        "Home": "\ue011",
        "End": "\ue010",
        "PageUp": "\ue00e",
        "PageDown": "\ue00f",
        "Insert": "\ue016",
        **{f"F{i}": chr(0xE031 + i - 1) for i in range(1, 13)},
    }
    MODIFIER_MAP = {
        "Control": "\ue009",
        "Ctrl": "\ue009",
        "Shift": "\ue008",
        "Alt": "\ue00a",
        "Meta": "\ue03d",
        "Cmd": "\ue03d",
        "Command": "\ue03d",
        # Platform Command-Mod: Meta on macOS (where CodeMirror and the
        # product map Mod to Cmd), Control elsewhere. Lets one `Mod+X`
        # chord drive the platform-native editing primitive on Linux,
        # Windows and macOS from a single testcase.
        "Mod": "\ue03d" if platform.system() == "Darwin" else "\ue009",
    }

    def _combo_actions(self, combo: str) -> list[dict[str, Any]]:
        parts = [p.strip() for p in combo.split("+") if p.strip()]
        if not parts:
            raise WebDriverError(f"press_combo: empty combo {combo!r}")
        mods: list[str] = []
        for p in parts[:-1]:
            if p not in self.MODIFIER_MAP:
                raise WebDriverError(f"press_combo: unknown modifier {p!r}")
            mods.append(self.MODIFIER_MAP[p])
        final = parts[-1]
        value = self.MODIFIER_MAP.get(final) or self.KEY_MAP.get(final) or final
        seq: list[dict[str, Any]] = [{"type": "keyDown", "value": m} for m in mods]
        seq.append({"type": "keyDown", "value": value})
        seq.append({"type": "pause", "duration": 30})
        seq.append({"type": "keyUp", "value": value})
        seq += [{"type": "keyUp", "value": m} for m in reversed(mods)]
        seq.append({"type": "pause", "duration": 30})
        return seq

    def press_combo(self, combo: str) -> str:
        """Press a chord like `Control+s`, `Control+Shift+p`, or a bare
        named key (`Enter`). Sends real key events through the W3C Actions
        API so CodeMirror/keydown handlers in the native WebView see them."""
        return self.press_combos([combo])

    def press_combos(self, combos: list[str]) -> str:
        """Send multiple chords in one W3C action request.

        WebKitWebDriver can reset its connection after many back-to-back
        /actions requests. A single input source preserves the same native
        keydown/keyup semantics without exercising that driver failure.
        """
        if platform.system() == "Darwin" and len(combos) > 1:
            # The macOS in-process bridge dispatches a whole sequence inside
            # one synchronous JS task. Read-modify-write strokes (undo/redo)
            # then race: every async consumer reads the same pre-burst
            # document and all but one collapse. One request per chord with
            # a settle gap keeps Darwin semantics equal to the real drivers.
            for index, combo in enumerate(combos):
                self.press_combos([combo])
                if index < len(combos) - 1:
                    time.sleep(0.2)
            return f"pressed {len(combos)} combo(s)"
        seq = [action for combo in combos for action in self._combo_actions(combo)]
        try:
            self.request(
                "POST",
                self.endpoint("/actions"),
                {"actions": [{"type": "key", "id": "keyboard", "actions": seq}]},
            )
        finally:
            # WebKitWebDriver may retain pressedCharKey even after explicit
            # keyUp events. Releasing all input sources keeps the next command
            # independent, especially after Enter and clipboard shortcuts.
            try:
                self.request("DELETE", self.endpoint("/actions"))
            except WebDriverError:
                pass
        return f"pressed {len(combos)} combo(s)"

    def type_text(self, text: str) -> str:
        """Type text into the focused element, one paced key pair per char."""
        if platform.system() == "Darwin":
            # The macOS in-process bridge dispatches a whole /actions
            # sequence inside one synchronous JS task. MutationObserver
            # callbacks then coalesce, so per-key latency sampling
            # (native_editor_performance) sees one batch instead of one
            # sample per key. One request per char preserves event-loop
            # turns; tauri-driver platforms keep the single batched request.
            for ch in text:
                self.request(
                    "POST",
                    self.endpoint("/actions"),
                    {"actions": [{"type": "key", "id": "keyboard", "actions": [
                        {"type": "keyDown", "value": ch},
                        {"type": "keyUp", "value": ch},
                        {"type": "pause", "duration": 20},
                    ]}]},
                )
            return f"typed {len(text)} chars"
        seq: list[dict[str, Any]] = []
        for ch in text:
            if ch.isupper():
                shift = self.MODIFIER_MAP["Shift"]
                seq.append({"type": "keyDown", "value": shift})
                seq.append({"type": "keyDown", "value": ch})
                seq.append({"type": "keyUp", "value": ch})
                seq.append({"type": "keyUp", "value": shift})
            else:
                seq.append({"type": "keyDown", "value": ch})
                seq.append({"type": "keyUp", "value": ch})
            # Let WebKit deliver the input transaction and CodeMirror finish
            # its scheduled measure before the next native character arrives.
            seq.append({"type": "pause", "duration": 20})
        try:
            self.request(
                "POST",
                self.endpoint("/actions"),
                {"actions": [{"type": "key", "id": "keyboard", "actions": seq}]},
            )
        finally:
            try:
                self.request("DELETE", self.endpoint("/actions"))
            except WebDriverError:
                pass
        return f"typed {len(text)} chars"

    def wait_absent(self, selector: str, timeout: float = 5.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                self.find(selector, timeout=0.5)
            except WebDriverError:
                return
        raise WebDriverError(f"element still present after {timeout}s: {selector}")

    def console_entries(self) -> list[dict[str, Any]]:
        try:
            data = self.execute("return window.__QA_UI_AUTO_CONSOLE__ || [];")
            return data if isinstance(data, list) else []
        except WebDriverError:
            return []

    def text(self, selector: str) -> str:
        # For terminal-pane, read the data-terminal-text attribute which is
        # kept in sync by TerminalPanel via a 500ms interval. This bypasses
        # the xterm.js canvas rendering that makes innerText always empty.
        try:
            attr = self.execute(
                f"const el = document.querySelector({json.dumps(selector)});"
                "return el ? (el.getAttribute('data-terminal-text') ?? el.innerText ?? '') : '';"
            )
            if attr is not None:
                return str(attr)
        except WebDriverError:
            pass
        element = self.find(selector)
        return str(self.request("GET", self.element_path(element, "/text")) or "")

    def screenshot(self, target: Path) -> str:
        data = self.request("GET", self.endpoint("/screenshot"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(str(data)))
        target.with_suffix(target.suffix + ".metadata.json").write_text(
            json.dumps({"capture_kind": "webview", "platform": platform.system(),
                        "actor": "WKWebView.takeSnapshot" if platform.system() == "Darwin" else "WebDriver",
                        "screen_recording_required": False}), encoding="utf-8")
        return str(target)

    def execute(self, script: str) -> Any:
        return self.request(
            "POST", self.endpoint("/execute/sync"), {"script": script, "args": []}
        )

    def install_console_hook(self) -> None:
        script = r"""
        if (!window.__QA_UI_AUTO_CONSOLE__) {
          window.__QA_UI_AUTO_CONSOLE__ = [];
          for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
            const original = console[level] ? console[level].bind(console) : console.log.bind(console);
            console[level] = (...args) => {
              try {
                window.__QA_UI_AUTO_CONSOLE__.push({
                  level,
                  time: new Date().toISOString(),
                  args: args.map((arg) => {
                    try {
                      if (arg instanceof Error) return arg.stack || arg.message;
                      if (typeof arg === 'string') return arg;
                      return JSON.stringify(arg);
                    } catch (_) {
                      return String(arg);
                    }
                  })
                });
              } catch (_) {}
              return original(...args);
            };
          }
          window.addEventListener('error', (event) => {
            window.__QA_UI_AUTO_CONSOLE__.push({
              level: 'error',
              time: new Date().toISOString(),
              args: [event.message, event.filename, event.lineno, event.colno]
            });
          });
          window.addEventListener('unhandledrejection', (event) => {
            window.__QA_UI_AUTO_CONSOLE__.push({
              level: 'error',
              time: new Date().toISOString(),
              args: ['unhandledrejection', String(event.reason)]
            });
          });
        }
        return true;
        """
        try:
            self.execute(script)
        except WebDriverError:
            pass


class NativeHarness:
    def __init__(self, cfg: dict, report_root: Path):
        self.cfg = cfg
        self.report_root = report_root
        self.application = native_binary(cfg)
        self.driver = TauriDriverProcess(cfg, report_root)
        self._previous_env: dict[str, str | None] = {}

    def __enter__(self) -> "NativeHarness":
        try:
            identity = verify_identity(self.application)
        except ValueError as exc:
            raise WebDriverError(str(exc)) from exc
        isolation_overrides = native_isolation_env(self.report_root)
        tooling_overrides, tooling_evidence = native_tooling_env(self.cfg)
        overrides = {**isolation_overrides, **tooling_overrides}
        if identity.get("source_sha256"):
            from qa_ui_auto.provenance import source_identity
            if identity["source_sha256"] != source_identity(ROOT):
                raise WebDriverError("QA binary source is stale; run native_build.py")
        self._previous_env = {key: os.environ.get(key) for key in overrides}
        try:
            for value in isolation_overrides.values():
                Path(value).mkdir(parents=True, exist_ok=True)
            os.environ.update(overrides)
            self.report_root.mkdir(parents=True, exist_ok=True)
            (self.report_root / "native-isolation.json").write_text(
                json.dumps({"identifier": QA_APP_ID, "binary": str(self.application.resolve()),
                            "binary_sha256": identity["binary_sha256"], "environment": isolation_overrides,
                            "tooling_environment": tooling_evidence,
                            "source_sha256": identity.get("source_sha256"),
                            "profile": identity.get("profile")}, indent=2) + "\n",
                encoding="utf-8",
            )
            self.driver.start()
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            self.driver.stop()
        finally:
            for key, previous in self._previous_env.items():
                if previous is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous
            self._previous_env.clear()

    def create_session(self, *, tooling_java_home: str | None = None) -> NativeSession:
        self.driver.ensure_running()
        java_home = tooling_java_home or self.cfg.get("app", {}).get("tooling_java_home")
        if java_home and self._previous_env:
            sdk_evidence = seed_native_tooling_sdk(self.report_root, str(java_home))
            isolation_path = self.report_root / "native-isolation.json"
            isolation_evidence = json.loads(isolation_path.read_text(encoding="utf-8"))
            isolation_evidence["tooling_sdk_registry"] = sdk_evidence
            isolation_path.write_text(
                json.dumps(isolation_evidence, indent=2) + "\n",
                encoding="utf-8",
            )
        session = NativeSession(self.driver.url, self.application, self.driver.mark_session_closed)
        session.deadline = getattr(self, "deadline", None)
        try:
            session.start()
            # A Java 25 project must not change the JDK used by unrelated
            # JDK 21 provider fixtures in the same selected suite.
            if java_home:
                session.execute(
                    "window.localStorage.setItem('taomni.codeWorkspace.lspJavaHome.v1', "
                    + json.dumps(str(java_home)) + "); return true;"
                )
        except BaseException:
            # If readiness fails after the bridge has started, there is no
            # session object for the runner's normal finally block to close.
            # Delete the half-started session so the driver terminates the
            # app; an orphaned app keeps the run-owned profile (SQLite,
            # WebView2) locked and every later case's reset fails.  Then mark
            # the process stale so the next case cannot reuse it.
            try:
                session.close()
            except Exception:  # noqa: BLE001 - preserve the original failure
                pass
            self.driver.mark_session_closed()
            raise
        return session


def native_tool_issues(cfg: dict) -> list[str]:
    issues: list[str] = []
    if platform.system() != "Darwin" and not shutil.which(str((cfg.get("webdriver") or {}).get("tauri_driver", "tauri-driver"))):
        issues += [
            "✗ tauri-driver not found on PATH.",
            "  Install: cargo install tauri-driver --locked",
            "  Install when needed within the authorized local test setup.",
        ]
    if platform.system() == "Windows" and not (
        (cfg.get("webdriver") or {}).get("native_driver") or shutil.which("msedgedriver")
    ):
        issues += [
            "✗ msedgedriver not found on PATH.",
            "  Download the Microsoft Edge Driver matching your Edge/WebView2 runtime,",
            "  then put msedgedriver.exe on PATH or set webdriver.native_driver.",
            "  This is not installed automatically because the version must match the local runtime.",
        ]
    return issues
