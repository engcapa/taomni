"""Own native session startup, bounded evidence, and half-started cleanup.

No retry, navigation, renderer mutation, or relaxed readiness is permitted here.
Evidence is captured while the original session is still alive, before DELETE
and the owned driver-tree cleanup can destroy the failure scene.
"""
from __future__ import annotations

import json
from pathlib import Path
import time
from typing import Any, Callable, Protocol, TypeVar
import urllib.error
from uuid import uuid4

from native_webdriver_transport import WebDriverError
from qa_ui_auto.deadline import Deadline


class StartupSession(Protocol):
    session_id: str | None
    deadline: Deadline | None
    last_request: dict[str, Any]

    def start(self) -> None: ...
    def execute(self, script: str) -> Any: ...
    def request(self, method: str, path: str, payload: dict | None = None) -> Any: ...
    def screenshot(self, target: Path) -> str: ...
    def close(self) -> None: ...


class OwnedProcess(Protocol):
    pid: int

    def poll(self) -> int | None: ...


class StartupDriver(Protocol):
    proc: OwnedProcess | None
    report_root: Path

    def mark_session_closed(self) -> None: ...


SessionT = TypeVar("SessionT", bound=StartupSession)

# Installed in each document, including a replacement for about:blank. Only
# observe startup errors; do not patch APIs, handle/recover errors, inspect
# storage, or record control values and document text.
STARTUP_OBSERVER = r"""
if (!window.__QA_UI_AUTO_STARTUP_ERRORS__) {
  const errors = [];
  window.__QA_UI_AUTO_STARTUP_ERRORS__ = errors;
  const resourcePath = value => {
    try {
      const url = new URL(value, location.href);
      return url.protocol + (url.host ? '//' + url.host : '') + url.pathname;
    }
    catch (_) { return null; }
  };
  const append = error => {
    errors.push(error);
    if (errors.length > 32) errors.shift();
  };
  window.addEventListener('error', event => {
    append({
      kind: event.target === window ? 'javascript' : 'resource',
      message: String(event.message ?? '').slice(0, 1000),
      source: resourcePath(event.filename || event.target?.src || event.target?.href || ''),
      line: event.lineno ?? null, column: event.colno ?? null
    });
  }, true);
  window.addEventListener('unhandledrejection', event => {
    append({kind: 'rejection', name: String(event.reason?.name ?? typeof event.reason).slice(0, 100)});
  });
}
"""

READINESS_SCRIPT = STARTUP_OBSERVER + """
return document.readyState === 'complete' && !!document.querySelector('#root > *');
"""

SNAPSHOT_SCRIPT = r"""
const resourcePath = value => {
  try {
      const url = new URL(value, location.href);
      return url.protocol + (url.host ? '//' + url.host : '') + url.pathname;
    }
  catch (_) { return null; }
};
const root = document.getElementById('root');
return {
  url: resourcePath(location.href), readyState: document.readyState,
  rootExists: !!root, rootChildren: root?.childElementCount ?? 0,
  bodyChildren: Array.from(document.body?.children ?? []).slice(0, 16).map(node => ({
    tag: node.tagName, id: node.id, testid: node.getAttribute('data-testid')
  })),
  tauriInternals: !!window.__TAURI_INTERNALS__,
  tauriInvoke: typeof window.__TAURI_INTERNALS__?.invoke === 'function',
  windowLabel: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null,
  webviewLabel: window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label ?? null,
  screenshotOverlay: location.hash === '#screenshot-overlay',
  errors: window.__QA_UI_AUTO_STARTUP_ERRORS__ ?? [],
  resources: performance.getEntriesByType('resource').slice(-32).map(entry => ({
    name: resourcePath(entry.name), type: entry.initiatorType,
    start: entry.startTime, duration: entry.duration,
    transferSize: entry.transferSize, decodedBodySize: entry.decodedBodySize,
    responseStatus: entry.responseStatus ?? null
  }))
};
"""


def wait_for_app_ready(session: StartupSession, timeout: float = 20.0) -> None:
    """Keep the original mounted-root predicate and authoritative case budget."""
    end = time.monotonic() + timeout
    last_error = ""
    while time.monotonic() < end:
        if session.deadline:
            session.deadline.remaining()
        try:
            ready = session.execute(READINESS_SCRIPT)
        except (WebDriverError, urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            last_error = str(exc)
        else:
            if ready is True:
                return
            last_error = "document root is not mounted"
        sleep_for = min(0.1, end - time.monotonic())
        if session.deadline:
            sleep_for = min(sleep_for, session.deadline.remaining())
        if sleep_for > 0:
            time.sleep(sleep_for)
    detail = f": {last_error}" if last_error else ""
    raise WebDriverError(f"native app document did not become ready within {timeout:.1f}s{detail}")


def _capture_failure(session: StartupSession, driver: StartupDriver, root: Path) -> dict[str, str]:
    """Share five seconds across live document and screenshot observations."""
    session.deadline = Deadline(5)
    root.mkdir(parents=True, exist_ok=True)
    evidence: dict[str, Any] = {
        "phase": "before_session_cleanup", "session_id": session.session_id,
        "last_request": dict(session.last_request),
    }
    if driver.proc is not None:
        evidence["driver_process"] = {"pid": driver.proc.pid, "exit_code": driver.proc.poll()}
    artifacts: dict[str, str] = {}
    for name, action in (
        ("document", lambda: session.execute(SNAPSHOT_SCRIPT)),
        ("window_handle", lambda: session.request("GET", f"/session/{session.session_id}/window")),
        ("window_handles", lambda: session.request("GET", f"/session/{session.session_id}/window/handles")),
        ("screenshot", lambda: session.screenshot(root / "webview.png")),
    ):
        if not session.session_id:
            evidence[name + "_unavailable"] = "session_not_created"
            continue
        try:
            session.deadline.remaining()
            value = action()
            if name == "screenshot":
                artifacts["startup_screenshot"] = str(value)
            else:
                evidence[name] = value
        except Exception as exc:
            # Do not include arbitrary transport bodies/URLs or replace the
            # original startup failure with an optional diagnostic failure.
            evidence[name + "_error_type"] = type(exc).__name__
    path = root / "startup.json"
    path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    return {"startup": str(path), **artifacts}


def start_owned_session(
    session: SessionT,
    driver: StartupDriver,
    *,
    java_home: str | None = None,
    diagnostics_dir: Path | None = None,
) -> SessionT:
    """Return a ready session or capture then release the half-started owner."""
    try:
        session.start()
        if java_home:
            session.execute(
                "window.localStorage.setItem('taomni.codeWorkspace.lspJavaHome.v1', "
                + json.dumps(str(java_home)) + "); return true;"
            )
    except BaseException as error:
        try:
            root = (diagnostics_dir if diagnostics_dir is not None else
                    driver.report_root / "native-startup" / uuid4().hex)
            artifacts = _capture_failure(session, driver, root)
            setattr(error, "native_startup_artifacts", artifacts)
        except Exception:
            pass  # The primary failure and cleanup remain authoritative.
        try:
            session.close()
        except Exception:
            pass
        try:
            driver.mark_session_closed()
        except Exception:
            pass
        raise
    return session


def create_case_session(
    create: Callable[..., SessionT],
    diagnostics_dir: Path,
    java_home: str | None,
    failure_artifacts: dict[str, str],
) -> SessionT:
    """Transfer the owner's startup receipts into the original failed case."""
    try:
        return create(tooling_java_home=java_home, diagnostics_dir=diagnostics_dir)
    except Exception as error:
        artifacts = getattr(error, "native_startup_artifacts", None)
        if isinstance(artifacts, dict):
            failure_artifacts.update(artifacts)
        raise
