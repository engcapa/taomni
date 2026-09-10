"""Verb dispatch for native-mode runs (R9 §8.19.10 native gate harness).

Mirrors the browser STEP_REGISTRY semantics on top of the WebDriver subset
implemented in scripts/tauri_webdriver.py. Verbs that cannot be expressed
through WebDriver (or that would lie about what was exercised) raise
StepError instead of silently passing — a native gate must fail loudly.

Native-only verbs:
* assert_file_contains  - host-side disk re-read of a saved workspace file
                          (the G0 disk-effect proof; impossible from browser).
* assert_file_exists    - host-side existence check.
* assert_file_receipt   - independent byte hash/encoding/receipt reconciliation.
* assert_file_sha256    - exact host-byte postcondition without reading source text.
* native_set_writable   - report-root-scoped Linux permission fault injection.
* native_clipboard_owner - external X11 CLIPBOARD selection owner: grant a real
                          OS payload, deny text conversion, or suspend the owner
                          so any client's selection read genuinely fails (the
                          clipboard analogue of the disk permission fault above).
* assert_system_clipboard - independent out-of-process read of the real X11
                          CLIPBOARD selection; the only proof that the app's
                          copy actually crossed the OS boundary.
* seed_clipboard         - controlled write through the packaged WebView
                          Clipboard API for native Windows clipboard flows.
* native_pointer_drag - modifier-aware pointer drag in the packaged WebKitGTK
                        session, targeted from read-only line/column geometry.
* native_windows_ime_keys - Win32 SendInput through a real Windows input
                            layout/IME, with layout restoration at teardown.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import platform
import re
import signal
import stat
import subprocess
import sys
from ctypes import wintypes
from .deadline import budget_time as time, remaining_timeout
from contextlib import suppress
from pathlib import Path
from typing import Any, Callable

from .steps import StepError


class NativeStepContext:
    """Per-case context handed to native verbs (fixture values resolved)."""

    def __init__(
        self,
        session: Any,
        case_dir: Path,
        cfg: dict,
        session_factory: Callable[[], Any] | None = None,
    ):
        self.session = session
        self.case_dir = case_dir
        self.cfg = cfg
        self.session_factory = session_factory
        self._permission_restores: dict[Path, int] = {}
        # External X11 CLIPBOARD owner started by native_clipboard_owner, plus
        # the host selection value captured before the case touched it.
        self._clipboard_owner: subprocess.Popen[str] | None = None
        self._clipboard_owner_suspended = False
        self._clipboard_owner_mode: str | None = None
        self._clipboard_owner_text: str | None = None
        self._host_clipboard_before: str | None = None
        self._host_clipboard_captured = False
        self._windows_ime_state: dict[str, Any] | None = None

    def restore_host_permissions(self) -> None:
        """Best-effort rollback for report-scoped fault injection.

        Also releases the external X11 clipboard owner and records that the
        host CLIPBOARD selection was replaced. X11 cannot retain a restored
        value without leaking a live owner process.
        """
        for path, mode in reversed(list(self._permission_restores.items())):
            try:
                path.chmod(mode)
            except OSError:
                pass
        self._permission_restores.clear()
        self._restore_windows_input_method()
        self._release_clipboard_owner()
        self._restore_host_clipboard()

    # -- external X11 clipboard owner -------------------------------------

    def _release_clipboard_owner(self) -> None:
        owner = self._clipboard_owner
        if owner is None:
            return
        try:
            if self._clipboard_owner_suspended:
                # A stopped process cannot act on any catchable signal; resume it
                # first so it can be reaped instead of lingering as a stopped
                # selection owner.
                os.kill(owner.pid, signal.SIGCONT)
                self._clipboard_owner_suspended = False
            # SIGKILL, not SIGTERM: an idle Tk mainloop blocks in C-level Tcl,
            # so Python never runs the bytecode that would service a catchable
            # signal and the owner would survive teardown holding the selection.
            owner.kill()
            owner.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        finally:
            for stream in (owner.stdout, owner.stderr):
                with suppress(Exception):
                    if stream is not None:
                        stream.close()
            self._clipboard_owner = None
            self._clipboard_owner_mode = None

    def _restore_host_clipboard(self) -> None:
        """Record that the host CLIPBOARD selection was replaced.

        The value is deliberately NOT republished. X11 keeps a selection only
        while some process owns it, so "restoring" it would mean leaving a
        detached owner behind after every run — a process leak, and one that can
        republish a payload this harness itself granted (a later case's snapshot
        of "host state" is often the previous case's payload). Testing the real
        system clipboard unavoidably replaces its contents; the honest contract
        is to disclose that in the artifact rather than fake a restore.
        """
        if not self._host_clipboard_captured:
            return
        previous = self._host_clipboard_before
        self._host_clipboard_captured = False
        self._host_clipboard_before = None
        artifact = self.case_dir / "native-clipboard-host-state.json"
        with suppress(OSError):
            artifact.write_text(
                json.dumps({
                    "display": os.environ.get("DISPLAY"),
                    "hostSelectionReplaced": True,
                    "hostSelectionRestored": False,
                    "reason": "X11 selections require a live owner; the runner does not "
                              "leave one behind, so the pre-case value is reported, not restored.",
                    "priorSelectionReadable": previous is not None,
                    "priorSelectionLength": len(previous) if previous else None,
                    "priorSelectionSha256": hashlib.sha256(previous.encode("utf-8")).hexdigest()
                    if previous else None,
                    "priorSelectionWasHarnessPayload": bool(
                        previous and previous in _GRANTED_CLIPBOARD_TEXTS
                    ),
                }, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )


def _screenshot(ctx: NativeStepContext, args: Any) -> str:
    target = args["path"] if isinstance(args, dict) else str(args)
    return ctx.session.screenshot(ctx.case_dir / target)


def _press(ctx: NativeStepContext, args: Any) -> str:
    if isinstance(args, str):
        key, selector = args, None
    elif isinstance(args, dict) and "key" in args:
        key = str(args["key"])
        selector = args.get("selector")
    else:
        raise StepError(f"press: expected string or {{key, selector?}}, got {args!r}")
    if selector:
        ctx.session.click(selector)
    return ctx.session.press_combo(key)


def _wait_for(ctx: NativeStepContext, args: Any) -> str:
    timeout = 10.0
    selectors: list[str]
    if isinstance(args, dict):
        raw = args.get("selector", args.get("text"))
        timeout = float(args.get("timeout_sec", timeout))
    else:
        raw = args
    if raw is None:
        raise StepError(f"wait_for: unsupported args {args!r}")
    selectors = raw if isinstance(raw, list) else [raw]
    last = ""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for sel in selectors:
            try:
                ctx.session.find(sel, timeout=0.5)
                return f"found {sel}"
            except Exception as e:  # noqa: BLE001
                last = str(e)
        time.sleep(0.25)
    raise StepError(f"wait_for: none found within {timeout}s ({last})")


def _assert_visible(ctx: NativeStepContext, args: Any) -> str:
    selector, timeout = _selector_args(args)
    try:
        ctx.session.find(selector, timeout=timeout)
    except Exception as e:  # noqa: BLE001
        raise StepError(f"assert_visible failed: {selector} ({e})") from e
    return f"visible {selector}"


def _assert_not_visible(ctx: NativeStepContext, args: Any) -> str:
    selector, timeout = _selector_args(args)
    try:
        ctx.session.wait_absent(selector, timeout=timeout)
    except Exception as e:  # noqa: BLE001
        raise StepError(f"assert_not_visible failed: {e}") from e
    return f"absent {selector}"


def _selector_args(args: Any) -> tuple[str, float]:
    if isinstance(args, str):
        return args, 10.0
    if isinstance(args, dict) and "selector" in args:
        return str(args["selector"]), float(args.get("timeout_sec", 10))
    raise StepError(f"expected selector string or {{selector, timeout_sec?}}, got {args!r}")


def _assert_text(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "selector" not in args or "contains" not in args:
        raise StepError(f"assert_text: expected {{selector, contains, timeout_sec?}}")
    selector = str(args["selector"])
    expected = str(args["contains"])
    timeout = float(args.get("timeout_sec", 10))
    deadline = time.time() + timeout
    text = ""
    while time.time() < deadline:
        try:
            text = ctx.session.text(selector)
        except Exception:  # noqa: BLE001
            text = ""
        if expected in text:
            return f"text ok: {selector}"
        time.sleep(0.3)
    raise StepError(
        f"assert_text failed: {selector!r} did not contain {expected!r}; last text={text[:200]!r}"
    )


def _is_transient_profile_race(exc: BaseException) -> bool:
    message = str(exc).lower()
    return "session not created" in message and any(
        marker in message
        for marker in (
            "cannot parse internal json template",
            "failed to write prefs file",
        )
    )


def _native_restart_app(ctx: NativeStepContext, args: Any) -> str:
    """Replace the packaged app session while keeping the same native case."""
    _ = args
    if ctx.session_factory is None:
        raise StepError("native_restart_app: session factory is unavailable")

    old_session = ctx.session
    old_session_id = getattr(old_session, "session_id", None)
    try:
        old_session.close()
    except Exception as exc:  # noqa: BLE001
        raise StepError(f"native_restart_app: could not close current session: {exc}") from exc

    replacement = None
    creation_attempts = 0
    for attempt in range(1, 5):
        creation_attempts = attempt
        try:
            replacement = ctx.session_factory()
            break
        except Exception as exc:  # noqa: BLE001
            if not _is_transient_profile_race(exc) or attempt == 4:
                raise StepError(
                    f"native_restart_app: could not create replacement session: {exc}"
                ) from exc
            time.sleep(0.25 * attempt)

    if replacement is None:
        raise StepError("native_restart_app: replacement session was not created")

    ctx.session = replacement
    new_session_id = getattr(replacement, "session_id", None)
    artifact = ctx.case_dir / "native-restart-observations.json"
    observations: list[dict[str, Any]] = []
    try:
        if artifact.exists():
            raw = json.loads(artifact.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                observations = raw
    except (OSError, ValueError):
        observations = []
    observations.append({
        "oldSessionId": old_session_id,
        "newSessionId": new_session_id,
        "sessionReplaced": old_session_id != new_session_id,
        "application": str(getattr(replacement, "application", "")),
        "sessionCreationAttempts": creation_attempts,
        "webviewUserDataFolder": (
            getattr(replacement, "webview_options", {}).get("userDataFolder")
            if isinstance(getattr(replacement, "webview_options", {}), dict)
            else None
        ),
        "platform": platform.platform(),
        "verifiedAtUnixMs": int(time.time() * 1000),
    })
    artifact.write_text(
        json.dumps(observations, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    if old_session_id == new_session_id:
        raise StepError(
            f"native_restart_app: replacement session id was not distinct ({new_session_id!r})"
        )
    return f"restarted native app session {old_session_id} -> {new_session_id}"


def _eval_readonly(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "expression" not in args:
        raise StepError("eval_readonly: expected {expression, ...}")
    expr = str(args["expression"])
    result = ctx.session.execute(f"return ({expr});")
    if args.get("expect_truthy", True) and not result:
        raise StepError(f"eval_readonly: expression returned falsy: {result!r}")
    if "contains" in args and args["contains"] not in str(result):
        raise StepError(f"eval_readonly: result {result!r} does not contain {args['contains']!r}")
    return f"eval ok"


def _hover(ctx: NativeStepContext, args: Any) -> str:
    selector, _ = _selector_args(args)
    element = ctx.session.find(selector, interactive=True)
    rect = ctx.session.request("GET", ctx.session.element_path(element, "/rect"))
    x = int(rect.get("x", 0) + rect.get("width", 0) / 2)
    y = int(rect.get("y", 0) + rect.get("height", 0) / 2)
    ctx.session.request(
        "POST",
        ctx.session.endpoint("/actions"),
        {
            "actions": [
                {
                    "type": "pointer",
                    "id": "mouse",
                    "parameters": {"pointerType": "mouse"},
                    "actions": [{"type": "pointerMove", "duration": 100, "x": x, "y": y,
                                 "origin": "viewport"}],
                }
            ]
        },
    )
    return f"hovered {selector}"


def _select_option(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "selector" not in args:
        raise StepError("select_option: expected {selector, value?|label?}")
    selector = str(args["selector"])
    value = args.get("value")
    label = args.get("label")
    if value is None and label is None:
        raise StepError("select_option: value or label is required")
    result = ctx.session.execute(
        f"const el = document.querySelector({json.dumps(selector)});"
        "if (!(el instanceof HTMLSelectElement)) return {ok:false, reason:'not-select'};"
        f"const expectedValue = {json.dumps(None if value is None else str(value))};"
        f"const expectedLabel = {json.dumps(None if label is None else str(label))};"
        "const option = Array.from(el.options).find((candidate) => "
        "(expectedValue !== null && candidate.value === expectedValue) || "
        "(expectedLabel !== null && candidate.text === expectedLabel));"
        "if (!option) return {ok:false, reason:'missing-option'};"
        "el.value = option.value;"
        "el.dispatchEvent(new Event('input', {bubbles:true}));"
        "el.dispatchEvent(new Event('change', {bubbles:true}));"
        "return {ok:true, value:el.value};"
    )
    if not isinstance(result, dict) or not result.get("ok"):
        raise StepError(f"select_option: could not select {value or label!r}: {result!r}")
    return f"selected {result.get('value')!r} in {selector}"


def _assert_attribute(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or not {"selector", "name", "equals"} <= set(args):
        raise StepError("assert_attribute: expected {selector, name, equals}")
    selector = str(args["selector"])
    name = str(args["name"])
    expected = str(args["equals"])
    actual = ctx.session.execute(
        f"const el = document.querySelector({json.dumps(selector)});"
        f"return el ? el.getAttribute({json.dumps(name)}) : null;"
    )
    if str(actual) != expected:
        raise StepError(f"assert_attribute: {selector}[{name}]={actual!r} != {expected!r}")
    return f"attribute ok: {selector}[{name}]"


def _assert_file_receipt(ctx: NativeStepContext, args: Any) -> str:
    """Independently hash host bytes and reconcile them with the DOM receipt."""
    required = {"path", "selector", "encoding", "bom", "eol", "expected_text"}
    if not isinstance(args, dict) or not required <= set(args):
        raise StepError(
            "assert_file_receipt: expected {path, selector, encoding, bom, eol, expected_text}"
        )
    path = Path(str(args["path"])).expanduser()
    selector = str(args["selector"])
    encoding = str(args["encoding"])
    normalized_encoding = encoding.strip().upper().replace("_", "-")
    expected_bom = bool(args["bom"])
    expected_eol = str(args["eol"]).lower()
    expected_text = str(args["expected_text"])
    require_history = bool(args.get("require_history", True))
    timeout = float(args.get("timeout_sec", 20))
    deadline = time.time() + timeout
    attrs: dict[str, Any] | None = None
    raw = b""
    disk_hash = ""

    attribute_names = [
        "data-state", "data-result-kind", "data-receipt-id", "data-transaction-id",
        "data-final-text-sha256", "data-encoded-bytes-sha256",
        "data-encoded-byte-length", "data-disk-post-sha256", "data-write-count",
        "data-encoding", "data-bom", "data-eol", "data-history-id",
    ]
    while time.time() < deadline:
        observed = ctx.session.execute(
            f"const el = document.querySelector({json.dumps(selector)});"
            f"const names = {json.dumps(attribute_names)};"
            "return el ? Object.fromEntries(names.map((name) => [name, el.getAttribute(name)])) : null;"
        )
        if isinstance(observed, dict) and path.exists():
            candidate = path.read_bytes()
            candidate_hash = hashlib.sha256(candidate).hexdigest()
            if (
                observed.get("data-state") == "saved"
                and observed.get("data-encoded-bytes-sha256") == candidate_hash
                and observed.get("data-disk-post-sha256") == candidate_hash
            ):
                attrs = observed
                raw = candidate
                disk_hash = candidate_hash
                break
        time.sleep(0.25)
    if attrs is None:
        raise StepError(
            f"assert_file_receipt: receipt did not converge with independently hashed bytes for {path}"
        )

    if attrs.get("data-result-kind") != "saved-current":
        raise StepError(f"assert_file_receipt: unexpected result kind {attrs.get('data-result-kind')!r}")
    if attrs.get("data-write-count") != "1":
        raise StepError(f"assert_file_receipt: write count is {attrs.get('data-write-count')!r}, expected '1'")
    if attrs.get("data-encoded-byte-length") != str(len(raw)):
        raise StepError(
            f"assert_file_receipt: byte length {attrs.get('data-encoded-byte-length')!r} != {len(raw)}"
        )
    observed_encoding = (attrs.get("data-encoding") or "").upper().replace("_", "-")
    if observed_encoding != normalized_encoding:
        raise StepError(
            f"assert_file_receipt: encoding {attrs.get('data-encoding')!r} != {encoding!r}"
        )
    if attrs.get("data-bom") != str(expected_bom).lower():
        raise StepError(f"assert_file_receipt: BOM metadata {attrs.get('data-bom')!r} is wrong")
    if attrs.get("data-eol") != expected_eol:
        raise StepError(f"assert_file_receipt: EOL metadata {attrs.get('data-eol')!r} != {expected_eol!r}")
    if require_history and not attrs.get("data-history-id"):
        raise StepError("assert_file_receipt: production receipt has no local-history identity")

    if normalized_encoding == "UTF-8":
        marker, codec = b"\xef\xbb\xbf", "utf-8"
    elif normalized_encoding == "UTF-16LE":
        marker, codec = b"\xff\xfe", "utf-16-le"
    elif normalized_encoding == "UTF-16BE":
        marker, codec = b"\xfe\xff", "utf-16-be"
    elif normalized_encoding in {"ISO-8859-1", "LATIN1"}:
        marker, codec = b"", "latin-1"
    else:
        raise StepError(f"assert_file_receipt: unsupported evidence encoding {encoding!r}")

    if marker:
        has_marker = raw.startswith(marker)
        if has_marker != expected_bom:
            raise StepError(
                f"assert_file_receipt: BOM bytes present={has_marker}, expected={expected_bom}"
            )
        payload = raw[len(marker):] if has_marker else raw
    else:
        payload = raw
    try:
        decoded = payload.decode(codec)
    except UnicodeDecodeError as exc:
        raise StepError(f"assert_file_receipt: host bytes do not decode as {encoding}: {exc}") from exc

    normalized_expected = expected_text.replace("\r\n", "\n").replace("\r", "\n")
    if expected_eol == "crlf":
        expected_disk_text = normalized_expected.replace("\n", "\r\n")
    elif expected_eol == "cr":
        expected_disk_text = normalized_expected.replace("\n", "\r")
    else:
        expected_disk_text = normalized_expected
    if decoded != expected_disk_text:
        raise StepError(
            "assert_file_receipt: decoded host bytes do not match the expected fixture text/EOL"
        )
    text_hash = hashlib.sha256(decoded.encode("utf-8")).hexdigest()
    if attrs.get("data-final-text-sha256") != text_hash:
        raise StepError(
            f"assert_file_receipt: logical text SHA {attrs.get('data-final-text-sha256')!r} != {text_hash}"
        )

    artifact = ctx.case_dir / "native-save-observations.json"
    observations: list[dict[str, Any]] = []
    if artifact.exists():
        try:
            loaded = json.loads(artifact.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                observations = loaded
        except (OSError, json.JSONDecodeError):
            observations = []
    observations.append({
        "platform": platform.system().lower(),
        "path": str(path),
        "encoding": encoding,
        "bom": expected_bom,
        "eol": expected_eol,
        "byteLength": len(raw),
        "diskBytesSha256": disk_hash,
        "receiptId": attrs.get("data-receipt-id"),
        "transactionId": attrs.get("data-transaction-id"),
        "historyId": attrs.get("data-history-id"),
        "verifiedAtUnixMs": int(time.time() * 1000),
    })
    artifact.write_text(json.dumps(observations, indent=2, sort_keys=True), encoding="utf-8")
    return f"native receipt verified: {encoding} bom={expected_bom} eol={expected_eol} sha256={disk_hash}"


def _assert_file_contains(ctx: NativeStepContext, args: Any) -> str:
    """Host-side G0 proof: re-read the saved file from the real filesystem."""
    if not isinstance(args, dict) or "path" not in args or "contains" not in args:
        raise StepError("assert_file_contains: expected {path, contains}")
    path = Path(str(args["path"])).expanduser()
    expected = str(args["contains"])
    timeout = float(args.get("timeout_sec", 15))
    deadline = time.time() + timeout
    body = ""
    while time.time() < deadline:
        if path.exists():
            body = path.read_text(encoding="utf-8", errors="replace")
            if expected in body:
                return f"disk verified: {path}"
        time.sleep(0.3)
    state = "missing" if not path.exists() else f"len={len(body)}"
    raise StepError(
        f"assert_file_contains failed after {timeout}s: {path} ({state}) "
        f"does not contain {expected!r}"
    )


def _assert_file_exists(ctx: NativeStepContext, args: Any) -> str:
    path_str = args["path"] if isinstance(args, dict) else str(args)
    path = Path(path_str).expanduser()
    timeout = float(args.get("timeout_sec", 10)) if isinstance(args, dict) else 10
    deadline = time.time() + timeout
    while time.time() < deadline:
        if path.exists():
            return f"exists {path}"
        time.sleep(0.25)
    raise StepError(f"assert_file_exists failed: {path} not created within {timeout}s")


def _assert_file_sha256(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or not {"path", "equals"} <= set(args):
        raise StepError("assert_file_sha256: expected {path, equals, timeout_sec?}")
    path = Path(str(args["path"])).expanduser()
    expected = str(args["equals"]).lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise StepError("assert_file_sha256: equals must be a lowercase SHA-256 hex digest")
    timeout = float(args.get("timeout_sec", 10))
    deadline = time.time() + timeout
    actual = "missing"
    while time.time() < deadline:
        if path.exists():
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            if actual == expected:
                return f"host byte SHA-256 verified: {actual}"
        time.sleep(0.25)
    raise StepError(
        f"assert_file_sha256: {path} hash {actual!r} != {expected!r} after {timeout}s"
    )


def _native_set_writable(ctx: NativeStepContext, args: Any) -> str:
    """Toggle owner-write only inside this run's retained report directory."""
    if platform.system() != "Linux":
        raise StepError("native_set_writable: requires Linux permission semantics")
    if not isinstance(args, dict) or not {"path", "writable"} <= set(args):
        raise StepError("native_set_writable: expected {path, writable}")
    requested = Path(str(args["path"])).expanduser()
    try:
        target = requested.resolve(strict=True)
    except OSError as exc:
        raise StepError(f"native_set_writable: cannot resolve {requested}: {exc}") from exc
    report_root = ctx.case_dir.parent.resolve()
    if not target.is_relative_to(report_root):
        raise StepError(
            f"native_set_writable: target must stay inside report root {report_root}"
        )
    writable = bool(args["writable"])
    before = stat.S_IMODE(target.stat().st_mode)
    ctx._permission_restores.setdefault(target, before)
    after = before | stat.S_IWUSR if writable else before & ~stat.S_IWUSR
    target.chmod(after)
    observed = stat.S_IMODE(target.stat().st_mode)
    if bool(observed & stat.S_IWUSR) != writable:
        raise StepError(
            f"native_set_writable: owner-write postcondition failed for {target}"
        )

    artifact = ctx.case_dir / "native-permission-observations.json"
    observations: list[dict[str, Any]] = []
    if artifact.exists():
        try:
            loaded = json.loads(artifact.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                observations = loaded
        except (OSError, json.JSONDecodeError):
            observations = []
    observations.append({
        "platform": platform.system().lower(),
        "path": str(target),
        "ownerWritable": writable,
        "beforeMode": f"{before:04o}",
        "afterMode": f"{observed:04o}",
        "verifiedAtUnixMs": int(time.time() * 1000),
    })
    artifact.write_text(json.dumps(observations, indent=2, sort_keys=True), encoding="utf-8")
    return f"owner writable={writable} for {target} ({before:04o}->{observed:04o})"


def _command_output(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=remaining_timeout(30))
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise StepError(f"native_ime_keys: {' '.join(command)} failed: {detail}")
    return result.stdout.strip()


def _active_x11_window() -> tuple[str, str]:
    root = _command_output(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
    window_id = root.rsplit(" ", 1)[-1]
    if window_id == "0x0":
        raise StepError("native_ime_keys: X11 has no active window")
    identity = _command_output(["xprop", "-id", window_id, "WM_CLASS", "_NET_WM_NAME"])
    if "taomni" not in identity.lower():
        raise StepError(f"native_ime_keys: active window is not Taomni: {identity}")
    return window_id, identity


def _activate_x11_application(application: Path) -> tuple[str, str]:
    """Activate only the X11 window owned by the exact test executable."""
    clients = _command_output(["xprop", "-root", "_NET_CLIENT_LIST_STACKING"])
    window_ids = [token.rstrip(",") for token in clients.split() if token.startswith("0x")]
    expected_executable = application.resolve()
    target: tuple[str, str] | None = None
    for window_id in reversed(window_ids):
        try:
            identity = _command_output([
                "xprop", "-id", window_id, "WM_CLASS", "_NET_WM_NAME", "_NET_WM_PID",
            ])
        except StepError:
            continue
        # QA builds have a distinct product name; match the executable via PID.
        pid_match = re.search(r"_NET_WM_PID\(CARDINAL\) = (\d+)", identity)
        if not pid_match:
            continue
        executable = Path(f"/proc/{pid_match.group(1)}/exe")
        try:
            if executable.resolve(strict=True) != expected_executable:
                continue
        except OSError:
            continue
        target = (window_id, identity)
        break
    if target is None:
        raise StepError(f"native X11: no window belongs to {expected_executable}")

    window_id, identity = target
    active = _command_output(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
    if active.rsplit(" ", 1)[-1] != window_id:
        activation = subprocess.run(
            ["wmctrl", "-ia", window_id],
            capture_output=True,
            text=True,
            check=False,
        )
        if activation.returncode != 0:
            detail = activation.stderr.strip() or activation.stdout.strip() or f"exit {activation.returncode}"
            raise StepError(f"native X11: could not activate {window_id}: {detail}")
        deadline = time.time() + 3
        while time.time() < deadline:
            active = _command_output(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
            if active.rsplit(" ", 1)[-1] == window_id:
                break
            time.sleep(0.1)
        else:
            raise StepError(f"native X11: {window_id} did not become active")
    return window_id, identity


def _x11_keysyms_for_chord(chord: str) -> list[int]:
    special_keysyms = {
        "Tab": 0xFF09,
        "Return": 0xFF0D,
        "Enter": 0xFF0D,
        "Home": 0xFF50,
        "End": 0xFF57,
        "ArrowUp": 0xFF52,
        "ArrowDown": 0xFF54,
        "ArrowLeft": 0xFF51,
        "ArrowRight": 0xFF53,
        "Escape": 0xFF1B,
        "Space": 0x0020,
        "Control": 0xFFE3,
        "Ctrl": 0xFFE3,
        "Shift": 0xFFE1,
        "Alt": 0xFFE9,
        "Meta": 0xFFE7,
        "F1": 0xFFBE,
        "F2": 0xFFBF,
        "F3": 0xFFC0,
        "F4": 0xFFC1,
        "F5": 0xFFC2,
        "F6": 0xFFC3,
        "F7": 0xFFC4,
        "F8": 0xFFC5,
        "F9": 0xFFC6,
        "F10": 0xFFC7,
        "F11": 0xFFC8,
        "F12": 0xFFC9,
    }
    parts = [part.strip() for part in chord.split("+") if part.strip()]
    if not parts:
        raise StepError(f"native_keys: empty X11 chord {chord!r}")
    keysyms: list[int] = []
    for key in parts:
        if len(key) == 1 and key.isascii():
            keysyms.append(ord(key))
        elif key in special_keysyms:
            keysyms.append(special_keysyms[key])
        else:
            raise StepError(f"native_keys: unsupported X11 key {key!r}")
    return keysyms


def _inject_x11_keys(keys: list[str]) -> None:
    x11 = ctypes.CDLL("libX11.so.6")
    xtst = ctypes.CDLL("libXtst.so.6")
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XKeysymToKeycode.restype = ctypes.c_uint
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    xtst.XTestFakeKeyEvent.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint,
        ctypes.c_int,
        ctypes.c_ulong,
    ]
    xtst.XTestFakeKeyEvent.restype = ctypes.c_int

    display = x11.XOpenDisplay(os.environ.get("DISPLAY", "").encode() or None)
    if not display:
        raise StepError(f"native_keys: cannot open X11 display {os.environ.get('DISPLAY')!r}")
    try:
        for chord in keys:
            keycodes: list[int] = []
            for keysym in _x11_keysyms_for_chord(chord):
                keycode = x11.XKeysymToKeycode(display, keysym)
                if keycode == 0:
                    raise StepError(f"native_keys: no X11 keycode for {chord!r}")
                keycodes.append(keycode)
            for keycode in keycodes:
                if xtst.XTestFakeKeyEvent(display, keycode, 1, 0) == 0:
                    raise StepError(f"native_keys: keyDown injection failed for {chord!r}")
                x11.XFlush(display)
                time.sleep(0.04)
            time.sleep(0.08)
            for keycode in reversed(keycodes):
                if xtst.XTestFakeKeyEvent(display, keycode, 0, 0) == 0:
                    raise StepError(f"native_keys: keyUp injection failed for {chord!r}")
                x11.XFlush(display)
                time.sleep(0.04)
            x11.XFlush(display)
            time.sleep(0.12)
    finally:
        x11.XCloseDisplay(display)


def _process_count(pattern: str) -> int:
    count = 0
    proc = Path("/proc")
    if not proc.is_dir():
        raise StepError("native process observations require Linux /proc")
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            continue
        if pattern in command:
            count += 1
    return count


def _assert_native_process_delta(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or not {"pattern", "baseline", "max_delta"} <= set(args):
        raise StepError("assert_native_process_delta: expected {pattern, baseline, max_delta}")
    pattern = str(args["pattern"])
    baseline = int(args["baseline"])
    max_delta = int(args["max_delta"])
    timeout = float(args.get("timeout_sec", 10))
    deadline = time.time() + timeout
    count = _process_count(pattern)
    while time.time() < deadline and count < baseline:
        time.sleep(0.25)
        count = _process_count(pattern)
    delta = count - baseline
    artifact = {
        "pattern": pattern,
        "baseline": baseline,
        "observed": count,
        "delta": delta,
        "maxDelta": max_delta,
        "source": "Linux /proc/*/cmdline",
    }
    (ctx.case_dir / "native-process-observation.json").write_text(
        json.dumps(artifact, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    if delta < 0 or delta > max_delta:
        raise StepError(
            f"process count for {pattern!r} changed by {delta}; expected 0..{max_delta} "
            f"(baseline={baseline}, observed={count})"
        )
    return f"process delta ok: {pattern!r} baseline={baseline} observed={count}"


def _native_editor_performance(ctx: NativeStepContext, args: Any) -> str:
    """Collect compact, real keydown-to-DOM samples from a mounted editor.

    ``max_p95_ms`` is retained as a collection guard for legacy cases. It is
    not a product budget claim; ED-AUDIT-005 compares repeated raw samples.
    """
    if not isinstance(args, dict) or not {"selector", "keys", "max_p95_ms"} <= set(args):
        raise StepError("native_editor_performance: expected {selector, keys, max_p95_ms}")
    selector = str(args["selector"])
    key_pattern = args["keys"]
    repeat_keys = int(args.get("repeat_keys", 1))
    if repeat_keys < 1:
        raise StepError("native_editor_performance: repeat_keys must be positive")
    keys = key_pattern * repeat_keys
    warmup_keys = args.get("warmup_keys", [])
    max_p95_ms = float(args["max_p95_ms"])
    if not isinstance(keys, list) or len(keys) < 5 or not all(
        isinstance(key, str) and len(key) == 1 and key.isascii() for key in keys
    ):
        raise StepError("native_editor_performance: keys must contain at least five ASCII characters")
    if not isinstance(warmup_keys, list) or not all(
        isinstance(key, str) and len(key) == 1 and key.isascii() for key in warmup_keys
    ):
        raise StepError("native_editor_performance: warmup_keys must contain ASCII characters")
    if warmup_keys and len(warmup_keys) < 20:
        raise StepError("native_editor_performance: warmup_keys must contain at least twenty characters")
    if warmup_keys and len(keys) < 200:
        raise StepError("native_editor_performance: measured keys must contain at least 200 characters")
    group_id = str(args.get("group_id", "default"))
    artifact_name = str(args.get("artifact_name", "native-editor-performance.json"))
    if Path(artifact_name).name != artifact_name or not artifact_name.endswith(".json"):
        raise StepError("native_editor_performance: artifact_name must be a file name ending in .json")
    fixture_path = args.get("fixture_path")
    fixture_label = str(args.get("fixture_label", group_id))
    fixture_observation: dict[str, Any] | None = None
    if fixture_path is not None:
        fixture = Path(str(fixture_path)).expanduser()
        if not fixture.is_file():
            raise StepError(f"native_editor_performance: fixture does not exist: {fixture}")
        fixture_bytes = fixture.read_bytes()
        fixture_observation = {
            "label": fixture_label,
            "path": fixture.as_posix(),
            "byteLength": len(fixture_bytes),
            "sha256": hashlib.sha256(fixture_bytes).hexdigest(),
        }

    focused = ctx.session.execute(
        f"const el = document.querySelector({json.dumps(selector)});"
        "return !!el && (document.activeElement === el || el.contains(document.activeElement));"
    )
    if not focused:
        raise StepError(f"native_editor_performance: target is not focused: {selector}")

    installed = ctx.session.execute(
        f"const el = document.querySelector({json.dumps(selector)});"
        "if (!(el instanceof HTMLElement)) return false;"
        "const state={pending:[],samples:[],keys:[],inputs:[],"
        "editorTextAtInstallLength:(el.textContent ?? '').length,"
        "domTextAtInstallLength:(el.textContent ?? '').length};"
        "const keydown=(event)=>{"
        " if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){"
        "   const pending={key:event.key,started:performance.now()}; state.pending.push(pending);"
        "   state.keys.push({key:event.key,started:pending.started,"
        "defaultPrevented:event.defaultPrevented});"
        " }"
        "};"
        "const input=(event)=>state.inputs.push({type:event.type,data:event.data ?? null,"
        "inputType:event.inputType ?? null});"
        "const observer=new MutationObserver((records)=>{"
        " if(!records.some((record)=>record.type==='characterData'||record.addedNodes.length||record.removedNodes.length))return;"
        " const pending=state.pending.shift(); if(!pending)return;"
        " const mutationLatencyMs=performance.now()-pending.started;"
        " const sample={key:pending.key,mutationLatencyMs,nextFrameLatencyMs:null,"
        "};"
        " state.samples.push(sample);"
        " requestAnimationFrame(()=>{sample.nextFrameLatencyMs=performance.now()-pending.started;});"
        "});"
        "el.addEventListener('keydown',keydown,true); el.addEventListener('beforeinput',input,true); el.addEventListener('input',input,true);"
        "observer.observe(el,{subtree:true,childList:true,characterData:true});"
        "window.__QA_NATIVE_EDITOR_PERF__={state,resetMeasured:()=>{state.pending=[];state.samples=[];state.keys=[];state.inputs=[];},cleanup:()=>{observer.disconnect();el.removeEventListener('keydown',keydown,true);el.removeEventListener('beforeinput',input,true);el.removeEventListener('input',input,true);}};"
        "return true;"
    )
    if not installed:
        raise StepError(f"native_editor_performance: selector not found: {selector}")

    def wait_for_samples(expected: int, label: str) -> None:
        deadline = time.time() + max(10, min(60, expected / 10))
        while time.time() < deadline:
            captured = int(ctx.session.execute(
                "return window.__QA_NATIVE_EDITOR_PERF__?.state.samples.length ?? 0;"
            ))
            if captured >= expected:
                return
            time.sleep(0.01)
        captured = int(ctx.session.execute(
            "return window.__QA_NATIVE_EDITOR_PERF__?.state.samples.length ?? 0;"
        ))
        raise StepError(
            f"native_editor_performance: captured {captured} {label} samples for {expected} physical keys"
        )

    # WebDriver key actions are delivered by the packaged native webview's
    # input source. XTest events are intentionally not used here: WebKitGTK
    # marks synthetic X11 modifier events untrusted and drops them before DOM
    # dispatch, which would measure the desktop harness rather than the editor.
    if warmup_keys:
        ctx.session.type_text("".join(warmup_keys))
        wait_for_samples(len(warmup_keys), "warmup")
        time.sleep(0.1)
        warmup_state = ctx.session.execute(
            "const state=window.__QA_NATIVE_EDITOR_PERF__?.state; return state ? {"
            "samples:state.samples,keys:state.keys,inputs:state.inputs} : null;"
        )
        ctx.session.execute("window.__QA_NATIVE_EDITOR_PERF__?.resetMeasured?.(); return true;")
    else:
        warmup_state = {"samples": [], "keys": [], "inputs": []}

    ctx.session.type_text("".join(keys))
    wait_for_samples(len(keys), "measured")
    time.sleep(0.35)
    performance_state = ctx.session.execute(
        "const harness=window.__QA_NATIVE_EDITOR_PERF__;"
        "if(!harness)return null;"
        "const state=harness.state; const target=document.querySelector(" + json.dumps(selector) + ");"
        "state.domTextAfterSettleLength=(target?.textContent ?? '').length;"
        "state.editorTextAfterSettle=target?.taomniDocumentSnapshot ?? null;"
        "const selection=window.getSelection();"
        "state.domSelectionAfterSettle=selection ? {anchorOffset:selection.anchorOffset,focusOffset:selection.focusOffset,isCollapsed:selection.isCollapsed} : null;"
        "harness.cleanup(); return state;"
    )
    samples = performance_state.get("samples") if isinstance(performance_state, dict) else None
    if not isinstance(samples, list) or len(samples) != len(keys):
        raise StepError(
            f"native_editor_performance: captured {len(samples) if isinstance(samples, list) else 0} "
            f"measured samples for {len(keys)} physical keys"
        )

    def sample_values(entries: Any) -> list[float]:
        if not isinstance(entries, list):
            return []
        return [float(sample["mutationLatencyMs"]) for sample in entries if isinstance(sample, dict) and "mutationLatencyMs" in sample]

    def summary(entries: Any) -> dict[str, Any]:
        raw = sample_values(entries)
        if not raw:
            return {"sampleCount": 0, "rawSamplesMs": [], "p50Ms": None, "p95Ms": None, "p99Ms": None, "maxMs": None}
        ordered = sorted(raw)

        def nearest_rank(quantile: float) -> float:
            rank = max(1, min(len(ordered), math.ceil(len(ordered) * quantile)))
            return ordered[rank - 1]

        return {
            "sampleCount": len(raw),
            "rawSamplesMs": raw,
            "p50Ms": nearest_rank(0.50),
            "p95Ms": nearest_rank(0.95),
            "p99Ms": nearest_rank(0.99),
            "maxMs": ordered[-1],
        }

    measured_summary = summary(samples)
    warmup_summary = summary(warmup_state.get("samples") if isinstance(warmup_state, dict) else [])
    next_frame_latencies = sorted(
        float(sample["nextFrameLatencyMs"])
        for sample in samples
        if isinstance(sample, dict) and isinstance(sample.get("nextFrameLatencyMs"), (int, float))
    )
    post_text = performance_state.get("editorTextAfterSettle")
    if not isinstance(post_text, str):
        raise StepError("native_editor_performance: editor text was unavailable after settle")
    post_hash = hashlib.sha256(post_text.encode("utf-8")).hexdigest()
    build_identity: dict[str, Any] = {}
    binary_value = (ctx.cfg.get("app") or {}).get("native_binary")
    if binary_value:
        binary = Path(str(binary_value))
        identity_path = binary.with_name(binary.name + ".qa-identity.json")
        with suppress(OSError, json.JSONDecodeError):
            loaded = json.loads(identity_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                build_identity = {
                    "profile": loaded.get("profile"),
                    "sourceSha256": loaded.get("source_sha256"),
                    "binarySha256": loaded.get("binary_sha256"),
                }
    artifact = {
        "schemaVersion": 2,
        "groupId": group_id,
        "fixture": fixture_observation,
        "environment": {
            "platform": platform.platform(),
            "os": platform.system(),
            "python": sys.version.split()[0],
            "webviewUserAgent": ctx.session.execute("return navigator.userAgent")
        },
        "build": build_identity,
        "warmup": {
            "keys": warmup_state.get("keys", []) if isinstance(warmup_state, dict) else [],
            "inputs": warmup_state.get("inputs", []) if isinstance(warmup_state, dict) else [],
            **warmup_summary,
        },
        "measured": {
            "keys": performance_state.get("keys", []),
            "keyPattern": key_pattern,
            "repeatKeys": repeat_keys,
            "inputs": performance_state.get("inputs", []),
            **measured_summary,
        },
        "sampleCount": measured_summary["sampleCount"],
        "keydownCount": len(performance_state.get("keys", [])),
        "pendingKeyCount": len(performance_state.get("pending", [])),
        "editorTextAtInstallLength": performance_state.get("editorTextAtInstallLength"),
        "domTextAtInstallLength": performance_state.get("domTextAtInstallLength"),
        "domTextAfterSettleLength": performance_state.get("domTextAfterSettleLength"),
        "editorTextAfterSettleLength": len(post_text),
        "editorTextAfterSettleSha256": post_hash,
        "domSelectionAfterSettle": performance_state.get("domSelectionAfterSettle"),
        "samples": samples,
        "nextFrameLatencyMs": next_frame_latencies,
        "nextFrameP95Ms": (
            next_frame_latencies[max(0, min(len(next_frame_latencies), math.ceil(len(next_frame_latencies) * 0.95)) - 1)]
            if next_frame_latencies else None
        ),
        "collectionGuardP95Ms": max_p95_ms,
        "absoluteBudgetClaim": False,
        "measurement": "native WebDriver keydown to CodeMirror DOM mutation",
        "nextFrameMeasurement": (
            "diagnostic only: requestAnimationFrame registered by MutationObserver; "
            "when CodeMirror mutates during its own animation frame this is the following frame, "
            "not the paint containing the mutation"
        ),
        "transport": "W3C WebDriver key actions -> packaged native webview",
    }
    (ctx.case_dir / artifact_name).write_text(
        json.dumps(artifact, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    p95 = measured_summary["p95Ms"]
    if isinstance(p95, (int, float)) and p95 > max_p95_ms:
        raise StepError(
            f"native editor input group {group_id!r} p95 {p95:.2f} ms exceeds collection guard "
            f"{max_p95_ms:.2f} ms ({len(samples)} samples)"
        )
    return f"native editor input group={group_id} p95={p95:.2f}ms ({len(samples)} measured keys)"


# --------------------------------------------------------------------------
# External X11 CLIPBOARD selection client.
#
# Both halves run OUT OF PROCESS from the app under test, so nothing here can
# observe or influence the app's internal state: the only channel is the real
# X11 CLIPBOARD selection. Tk is used because it is the one X11 selection client
# guaranteed present with CPython; this host has no xclip/xsel/wl-copy.
# --------------------------------------------------------------------------

# Every payload this runner process has ever published to the X11 CLIPBOARD.
# The restore guard is process-wide, not per-case: with several cases in one
# run, case N's snapshot of "host state" can be exactly what case N-1 granted,
# and republishing that would fake a restore and leak an owner.
_GRANTED_CLIPBOARD_TEXTS: set[str] = set()


_CLIPBOARD_OWNER_SOURCE = r"""
import sys, tkinter as tk
root = tk.Tk(); root.withdraw()
root.clipboard_clear(); root.clipboard_append(sys.argv[1])
root.update()
sys.stdout.write("OWNER-READY\n"); sys.stdout.flush()
root.mainloop()
"""

_CLIPBOARD_DENY_OWNER_SOURCE = r"""
import ctypes, ctypes.util, sys

X11 = ctypes.CDLL(ctypes.util.find_library("X11"))
Window = ctypes.c_ulong
Atom = ctypes.c_ulong

class XSelectionRequestEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("owner", Window),
        ("requestor", Window),
        ("selection", Atom),
        ("target", Atom),
        ("property", Atom),
        ("time", ctypes.c_ulong),
    ]

class XSelectionEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("requestor", Window),
        ("selection", Atom),
        ("target", Atom),
        ("property", Atom),
        ("time", ctypes.c_ulong),
    ]

class XEvent(ctypes.Union):
    _fields_ = [
        ("type", ctypes.c_int),
        ("xselectionrequest", XSelectionRequestEvent),
        ("xselection", XSelectionEvent),
        ("pad", ctypes.c_long * 24),
    ]

X11.XOpenDisplay.argtypes = [ctypes.c_char_p]
X11.XOpenDisplay.restype = ctypes.c_void_p
X11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
X11.XDefaultRootWindow.restype = Window
X11.XCreateSimpleWindow.argtypes = [
    ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_int,
    ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
    ctypes.c_ulong, ctypes.c_ulong,
]
X11.XCreateSimpleWindow.restype = Window
X11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
X11.XInternAtom.restype = Atom
X11.XSetSelectionOwner.argtypes = [ctypes.c_void_p, Atom, Window, ctypes.c_ulong]
X11.XGetSelectionOwner.argtypes = [ctypes.c_void_p, Atom]
X11.XGetSelectionOwner.restype = Window
X11.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.POINTER(XEvent)]
X11.XChangeProperty.argtypes = [
    ctypes.c_void_p, Window, Atom, Atom, ctypes.c_int,
    ctypes.c_int, ctypes.POINTER(ctypes.c_ubyte), ctypes.c_int,
]
X11.XSendEvent.argtypes = [
    ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_long, ctypes.POINTER(XEvent),
]
X11.XFlush.argtypes = [ctypes.c_void_p]

display = X11.XOpenDisplay(None)
if not display:
    raise RuntimeError("cannot open X11 display")
root = X11.XDefaultRootWindow(display)
owner = X11.XCreateSimpleWindow(display, root, 0, 0, 1, 1, 0, 0, 0)
clipboard = X11.XInternAtom(display, b"CLIPBOARD", 0)
targets = X11.XInternAtom(display, b"TARGETS", 0)
utf8 = X11.XInternAtom(display, b"UTF8_STRING", 0)
text = X11.XInternAtom(display, b"TEXT", 0)
string = X11.XInternAtom(display, b"STRING", 0)
atom = 4
X11.XSetSelectionOwner(display, clipboard, owner, 0)
X11.XFlush(display)
if X11.XGetSelectionOwner(display, clipboard) != owner:
    raise RuntimeError("failed to own CLIPBOARD")
sys.stdout.write("OWNER-READY\n"); sys.stdout.flush()

while True:
    event = XEvent()
    X11.XNextEvent(display, ctypes.byref(event))
    if event.type != 30:
        continue
    request = event.xselectionrequest
    reply_property = 0
    if request.target == targets:
        reply_property = request.property or request.target
        advertised = (Atom * 4)(targets, utf8, text, string)
        X11.XChangeProperty(
            display,
            request.requestor,
            reply_property,
            atom,
            32,
            0,
            ctypes.cast(advertised, ctypes.POINTER(ctypes.c_ubyte)),
            len(advertised),
        )
    reply = XEvent()
    reply.xselection = XSelectionEvent(
        31,
        0,
        1,
        display,
        request.requestor,
        request.selection,
        request.target,
        reply_property,
        request.time,
    )
    X11.XSendEvent(display, request.requestor, 0, 0, ctypes.byref(reply))
    X11.XFlush(display)
"""

_CLIPBOARD_READER_SOURCE = r"""
import json, sys, tkinter as tk
root = tk.Tk(); root.withdraw()
try:
    value = root.clipboard_get()
    sys.stdout.write(json.dumps({"ok": True, "text": value}))
except Exception as exc:
    sys.stdout.write(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
"""


def _spawn_clipboard_owner(
    text: str | None = None,
    *,
    deny_text_conversion: bool = False,
) -> subprocess.Popen[str]:
    """Own the X11 CLIPBOARD selection from a separate process."""
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native clipboard: requires a Linux X11 display")
    if deny_text_conversion:
        command = [sys.executable, "-c", _CLIPBOARD_DENY_OWNER_SOURCE]
    else:
        if text is None:
            raise StepError("native clipboard: text owner requires a payload")
        command = [sys.executable, "-c", _CLIPBOARD_OWNER_SOURCE, text]
    proc = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.time() + 20
    while time.time() < deadline:
        if proc.poll() is not None:
            err = (proc.stderr.read() if proc.stderr else "") or f"exit {proc.returncode}"
            raise StepError(f"native clipboard: owner process died: {err.strip()}")
        line = proc.stdout.readline() if proc.stdout else ""
        if line.strip() == "OWNER-READY":
            return proc
    with suppress(OSError):
        proc.kill()
    raise StepError("native clipboard: owner process did not take the CLIPBOARD selection")


def _read_x11_clipboard(timeout: float = 30.0) -> dict[str, Any]:
    """Read the real CLIPBOARD selection from a separate process.

    A missing or unresponsive owner is reported as `{"ok": False}` with the X11
    error text rather than as an empty string, so a stalled selection transfer
    can never be mistaken for an empty clipboard.
    """
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native clipboard: requires a Linux X11 display")
    try:
        result = subprocess.run(
            [sys.executable, "-c", _CLIPBOARD_READER_SOURCE],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"external X11 read exceeded {timeout}s"}
    if result.returncode != 0:
        detail = result.stderr.strip() or f"exit {result.returncode}"
        return {"ok": False, "error": detail}
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": f"unparsable reader output: {exc}"}
    return payload if isinstance(payload, dict) else {"ok": False, "error": "reader returned non-object"}


def _append_clipboard_observation(ctx: NativeStepContext, entry: dict[str, Any]) -> None:
    artifact = ctx.case_dir / "native-clipboard-observations.json"
    observations: list[dict[str, Any]] = []
    if artifact.exists():
        try:
            loaded = json.loads(artifact.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                observations = loaded
        except (OSError, json.JSONDecodeError):
            observations = []
    observations.append({
        "platform": platform.platform(),
        "display": os.environ.get("DISPLAY"),
        "transport": "external X11 CLIPBOARD selection (out-of-process Tk client)",
        "verifiedAtUnixMs": int(time.time() * 1000),
        **entry,
    })
    artifact.write_text(
        json.dumps(observations, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )


VERBS: dict[str, Callable[[NativeStepContext], str]] = {}


def _verb(name: str) -> Callable[[Callable[[NativeStepContext, Any], str]], Callable[[NativeStepContext, Any], str]]:
    def deco(fn: Callable[[NativeStepContext, Any], str]) -> Callable[[NativeStepContext, Any], str]:
        VERBS[name] = fn
        return fn

    return deco


@_verb("open")
@_verb("goto")
def _noop_open(ctx: NativeStepContext, args: Any) -> str:
    # tauri-driver launches the binary as part of session creation; there is
    # nothing to navigate in a packaged app window.
    return "no-op (app already launched by driver)"


@_verb("native_restart_app")
def _do_native_restart_app(ctx: NativeStepContext, args: Any) -> str:
    return _native_restart_app(ctx, args)


@_verb("screenshot")
def _do_screenshot(ctx: NativeStepContext, args: Any) -> str:
    return _screenshot(ctx, args)


@_verb("click")
def _do_click(ctx: NativeStepContext, args: Any) -> str:
    selector, _ = _selector_args(args)
    return ctx.session.click(selector)


@_verb("dblclick")
def _do_dblclick(ctx: NativeStepContext, args: Any) -> str:
    selector, _ = _selector_args(args)
    return ctx.session.dblclick(selector)


@_verb("fill")
def _do_fill(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "selector" not in args or "value" not in args:
        raise StepError("fill: expected {selector, value}")
    return ctx.session.fill(str(args["selector"]), str(args["value"]))


@_verb("type")
@_verb("send_keys")
def _do_type(ctx: NativeStepContext, args: Any) -> str:
    return ctx.session.type_text(str(args))


@_verb("press")
def _do_press(ctx: NativeStepContext, args: Any) -> str:
    return _press(ctx, args)


@_verb("wait_for")
def _do_wait_for(ctx: NativeStepContext, args: Any) -> str:
    return _wait_for(ctx, args)


@_verb("wait")
def _do_wait(ctx: NativeStepContext, args: Any) -> str:
    seconds = float(args if isinstance(args, (int, float)) else (args or {}).get("seconds", 1))
    time.sleep(seconds)
    return f"waited {seconds}s"


@_verb("assert_visible")
def _do_assert_visible(ctx: NativeStepContext, args: Any) -> str:
    return _assert_visible(ctx, args)


@_verb("assert_not_visible")
def _do_assert_not_visible(ctx: NativeStepContext, args: Any) -> str:
    return _assert_not_visible(ctx, args)


@_verb("assert_text")
def _do_assert_text(ctx: NativeStepContext, args: Any) -> str:
    return _assert_text(ctx, args)


@_verb("assert_pattern")
def _do_assert_pattern(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "selector" not in args or "regex" not in args:
        raise StepError("assert_pattern: expected {selector, regex, timeout_sec?}")
    pattern = re.compile(args["regex"])
    timeout = min(float(args.get("timeout_sec", 10)), remaining_timeout(float(args.get("timeout_sec", 10))))
    expires = time.monotonic() + timeout
    while time.monotonic() < expires:
        text = ctx.session.text(args["selector"])
        if pattern.search(text):
            return f"pattern matched: {args['selector']}"
        time.sleep(0.25)
    raise StepError(f"assert_pattern failed: {args['selector']} did not match {args['regex']!r}")


@_verb("eval_readonly")
def _do_eval_readonly(ctx: NativeStepContext, args: Any) -> str:
    return _eval_readonly(ctx, args)


@_verb("capture_workspace_restore_performance")
def _capture_workspace_restore_performance(ctx: NativeStepContext, args: Any) -> str:
    """Persist the current production restore observation without driving it."""
    if not isinstance(args, dict):
        raise StepError(
            "capture_workspace_restore_performance: expected "
            "{artifact_name, sample_id?, group?, require_tab_count?}"
        )
    artifact_name = str(args.get("artifact_name", "workspace-restore-performance.json"))
    if Path(artifact_name).name != artifact_name or not artifact_name.endswith(".json"):
        raise StepError("capture_workspace_restore_performance: artifact_name must be a JSON filename")
    wait_timeout_sec = max(0.0, float(args.get("wait_timeout_sec", 0)))
    wait_deadline = time.monotonic() + (
        min(wait_timeout_sec, remaining_timeout(wait_timeout_sec)) if wait_timeout_sec > 0 else 0
    )
    run: dict[str, Any] | None = None
    while True:
        raw_runs = ctx.session.execute(
            "return window.__TAOMNI_WORKSPACE_RESTORE_PERFORMANCE__?.runs ?? [];"
        )
        if isinstance(raw_runs, list) and raw_runs:
            candidate = raw_runs[-1]
            if not isinstance(candidate, dict):
                raise StepError("capture_workspace_restore_performance: production observation has invalid shape")
            run = candidate
            if candidate.get("activeReadyAtMs") is not None and candidate.get("allReadyAtMs") is not None:
                break
        if time.monotonic() >= wait_deadline:
            if run is None:
                raise StepError("capture_workspace_restore_performance: production restore observation is missing")
            raise StepError(
                "capture_workspace_restore_performance: active-ready/all-ready timing is incomplete"
            )
        time.sleep(min(0.1, max(0.01, wait_deadline - time.monotonic())))
    assert run is not None
    required_tab_count = args.get("require_tab_count")
    if required_tab_count is not None:
        expected = int(required_tab_count)
        actual = int(run.get("activeTargetCount", 0)) + int(run.get("backgroundTargetCount", 0))
        if actual != expected:
            raise StepError(
                f"capture_workspace_restore_performance: expected {expected} targets, got {actual}"
            )
    events = run.get("events")
    if not isinstance(events, list):
        raise StepError("capture_workspace_restore_performance: event list is missing")
    read_starts = [event for event in events if isinstance(event, dict) and event.get("kind") == "read-start"]
    settled = [
        event for event in events
        if isinstance(event, dict) and event.get("kind") in {"ready", "failed", "cancelled"}
    ]
    if len(read_starts) != len(set(event.get("key") for event in read_starts)):
        raise StepError("capture_workspace_restore_performance: duplicate read target observed")
    if len(set(event.get("key") for event in read_starts)) != len(set(event.get("key") for event in settled)):
        raise StepError("capture_workspace_restore_performance: read/settled target counts disagree")
    required_failures = args.get("require_failed_count")
    if required_failures is not None:
        actual_failures = sum(1 for event in settled if event.get("kind") == "failed")
        if actual_failures != int(required_failures):
            raise StepError(
                f"capture_workspace_restore_performance: expected {required_failures} failures, "
                f"got {actual_failures}"
            )
    payload = {
        "schemaVersion": 1,
        "kind": "workspace-restore-performance",
        "sampleId": str(args.get("sample_id", artifact_name.removesuffix(".json"))),
        "group": str(args.get("group", "current")),
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "webview": "packaged Tauri WebDriver session",
        },
        "run": run,
        "derived": {
            "activeReadyMs": run["activeReadyAtMs"] - run["startedAtMs"],
            "allReadyMs": run["allReadyAtMs"] - run["startedAtMs"],
            "readStartCount": len(read_starts),
            "settledCount": len(settled),
            "failedCount": sum(1 for event in settled if event.get("kind") == "failed"),
            "cancelledCount": sum(1 for event in settled if event.get("kind") == "cancelled"),
        },
    }
    output = ctx.case_dir / artifact_name
    output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return (
        f"captured restore performance {payload['sampleId']} "
        f"active={payload['derived']['activeReadyMs']:.2f}ms "
        f"all={payload['derived']['allReadyMs']:.2f}ms"
    )


@_verb("hover")
def _do_hover(ctx: NativeStepContext, args: Any) -> str:
    return _hover(ctx, args)


@_verb("select_option")
def _do_select_option(ctx: NativeStepContext, args: Any) -> str:
    return _select_option(ctx, args)


@_verb("assert_attribute")
def _do_assert_attribute(ctx: NativeStepContext, args: Any) -> str:
    return _assert_attribute(ctx, args)


@_verb("assert_file_contains")
def _do_assert_file_contains(ctx: NativeStepContext, args: Any) -> str:
    return _assert_file_contains(ctx, args)


@_verb("assert_file_exists")
def _do_assert_file_exists(ctx: NativeStepContext, args: Any) -> str:
    return _assert_file_exists(ctx, args)


@_verb("assert_file_receipt")
def _do_assert_file_receipt(ctx: NativeStepContext, args: Any) -> str:
    return _assert_file_receipt(ctx, args)


@_verb("assert_file_sha256")
def _do_assert_file_sha256(ctx: NativeStepContext, args: Any) -> str:
    return _assert_file_sha256(ctx, args)


@_verb("native_set_writable")
def _do_native_set_writable(ctx: NativeStepContext, args: Any) -> str:
    return _native_set_writable(ctx, args)


@_verb("native_keys")
def _do_native_keys(ctx: NativeStepContext, args: Any) -> str:
    """Inject native keys into an already-focused native control."""
    if not isinstance(args, dict):
        raise StepError("native_keys: expected {selector, keys}")
    selector = args.get("selector")
    keys = args.get("keys")
    transport = str(args.get("transport", "x11"))
    if not isinstance(selector, str) or not selector:
        raise StepError("native_keys: selector must be a non-empty string")
    if not isinstance(keys, list) or not keys or not all(isinstance(key, str) for key in keys):
        raise StepError("native_keys: keys must be a non-empty string array")

    focus_prechecked = args.get("focus_prechecked") is True
    if not focus_prechecked:
        focused = ctx.session.execute(
            f"const el = document.querySelector({json.dumps(selector)});"
            "return !!el && (document.activeElement === el || el.contains(document.activeElement));"
        )
        if not focused:
            raise StepError(
                f"native_keys: target must already have DOM focus before native injection: {selector}"
            )
    if not focus_prechecked:
        ctx.session.execute(
            "window.__QA_NATIVE_KEY_EVENTS__=[];"
            "window.__QA_NATIVE_KEY_LISTENER__=(event)=>window.__QA_NATIVE_KEY_EVENTS__.push({"
            "type:event.type,key:event.key,code:event.code,ctrlKey:event.ctrlKey,"
            "altKey:event.altKey,shiftKey:event.shiftKey,metaKey:event.metaKey,"
            "defaultPrevented:event.defaultPrevented});"
            "window.addEventListener('keydown',window.__QA_NATIVE_KEY_LISTENER__,true);"
            "window.addEventListener('keyup',window.__QA_NATIVE_KEY_LISTENER__,true);"
        )
    time.sleep(0.25)
    window_id = None
    window_identity = None
    if transport == "webdriver":
        ctx.session.press_combos(keys)
    elif transport == "x11":
        if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
            raise StepError("native_keys: X11 transport requires a Linux display")
        window_id, window_identity = _activate_x11_application(ctx.session.application)
        _inject_x11_keys(keys)
    else:
        raise StepError(f"native_keys: unsupported transport {transport!r}")
    time.sleep(0.5)
    observed_events = None if focus_prechecked else ctx.session.execute(
        "const events=window.__QA_NATIVE_KEY_EVENTS__ ?? [];"
        "window.removeEventListener('keydown',window.__QA_NATIVE_KEY_LISTENER__,true);"
        "window.removeEventListener('keyup',window.__QA_NATIVE_KEY_LISTENER__,true);"
        "return events;"
    )
    artifact = {
        "platform": platform.platform(),
        "display": os.environ.get("DISPLAY"),
        "active_window": window_id,
        "window_identity": window_identity,
        "focused_selector": selector,
        "focus_verification": "testcase precondition" if focus_prechecked else "immediate DOM probe",
        "keys": keys,
        "observed_events": observed_events,
        "transport": (
            "W3C WebDriver key actions -> platform WebView"
            if transport == "webdriver"
            else "X11 XTest -> GTK/WebKitGTK"
        ),
        "result": "keys-injected; testcase DOM postcondition is authoritative",
    }
    (ctx.case_dir / "native-key-observation.json").write_text(
        json.dumps(artifact, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return f"injected {len(keys)} {transport} keys into focused native control"


_WINDOWS_INPUT_LAYOUT_REQUEST = 0x0050
_WINDOWS_KEYEVENTF_KEYUP = 0x0002
_WINDOWS_INPUT_KEYBOARD = 1
_WINDOWS_KLF_ACTIVATE = 0x00000001
_WINDOWS_WM_IME_CONTROL = 0x0283
_WINDOWS_IMC_GETCONVERSIONMODE = 0x0001
_WINDOWS_IMC_SETCONVERSIONMODE = 0x0002
_WINDOWS_IMC_GETSENTENCEMODE = 0x0003
_WINDOWS_IMC_GETOPENSTATUS = 0x0005
_WINDOWS_IMC_SETOPENSTATUS = 0x0006
_WINDOWS_IME_CMODE_NATIVE = 0x0001
_WINDOWS_VK = {
    "BACKSPACE": 0x08,
    "CONTROL": 0x11,
    "CTRL": 0x11,
    "TAB": 0x09,
    "ENTER": 0x0D,
    "ESCAPE": 0x1B,
    "SHIFT": 0x10,
    "SPACE": 0x20,
    "ARROWLEFT": 0x25,
    "ARROWUP": 0x26,
    "ARROWRIGHT": 0x27,
    "ARROWDOWN": 0x28,
}


class _WindowsKeybdInput(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _WindowsInputUnion(ctypes.Union):
    # INPUT's union is sized by MOUSEINPUT (32 bytes on Win64), even when the
    # keyboard member is the only one used here. SendInput rejects a shorter
    # structure with ERROR_INVALID_PARAMETER.
    _fields_ = [
        ("ki", _WindowsKeybdInput),
        ("_layout_padding", ctypes.c_byte * 32),
    ]


class _WindowsInput(ctypes.Structure):
    _anonymous_ = ("data",)
    _fields_ = [
        ("type", wintypes.DWORD),
        ("data", _WindowsInputUnion),
    ]


class _WindowsGuiThreadInfo(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("hwndActive", wintypes.HWND),
        ("hwndFocus", wintypes.HWND),
        ("hwndCapture", wintypes.HWND),
        ("hwndMenuOwner", wintypes.HWND),
        ("hwndMoveSize", wintypes.HWND),
        ("hwndCaret", wintypes.HWND),
        ("rcCaret", wintypes.RECT),
    ]


def _windows_user32() -> Any:
    if platform.system() != "Windows":
        raise StepError("native_windows_ime_keys: requires Windows")
    return ctypes.WinDLL("user32", use_last_error=True)


def _windows_foreground_info(user32: Any) -> dict[str, Any]:
    hwnd = int(user32.GetForegroundWindow() or 0)
    if hwnd == 0:
        return {"hwnd": None, "title": "", "class": ""}
    title_length = int(user32.GetWindowTextLengthW(hwnd))
    title_buffer = ctypes.create_unicode_buffer(max(title_length + 1, 1))
    user32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
    class_buffer = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, class_buffer, len(class_buffer))
    return {
        "hwnd": f"0x{hwnd:x}",
        "title": title_buffer.value,
        "class": class_buffer.value,
    }


def _windows_process_image(kernel32: Any, pid: int) -> str | None:
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.QueryFullProcessImageNameW.argtypes = [
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(buffer))
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return None
        return buffer.value
    finally:
        kernel32.CloseHandle(handle)


def _windows_application_window(application: Path) -> tuple[int, int]:
    user32 = _windows_user32()
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD
    expected = os.path.normcase(str(application.resolve()))
    found: list[tuple[int, int]] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def visit(hwnd: int, _lparam: int) -> int:
        if not user32.IsWindowVisible(hwnd):
            return 1
        pid = wintypes.DWORD()
        thread_id = int(user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid)))
        image = _windows_process_image(kernel32, int(pid.value))
        if image is None:
            return 1
        normalized = os.path.normcase(str(Path(image).resolve()))
        if normalized == expected:
            found.append((int(hwnd), thread_id))
            return 0
        return 1

    callback = callback_type(visit)
    user32.EnumWindows(callback, 0)
    if not found:
        raise StepError(
            "native_windows_ime_keys: could not find a visible window for "
            f"{application.resolve()}"
        )
    hwnd, thread_id = found[0]
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.AttachThreadInput.restype = wintypes.BOOL
    user32.SetActiveWindow.argtypes = [wintypes.HWND]
    user32.SetActiveWindow.restype = wintypes.HWND
    user32.SetFocus.argtypes = [wintypes.HWND]
    user32.SetFocus.restype = wintypes.HWND
    user32.SwitchToThisWindow.argtypes = [wintypes.HWND, wintypes.BOOL]
    user32.SwitchToThisWindow.restype = None
    foreground = int(user32.GetForegroundWindow() or 0)
    foreground_thread = wintypes.DWORD()
    if foreground:
        user32.GetWindowThreadProcessId(foreground, ctypes.byref(foreground_thread))
    current_thread = int(kernel32.GetCurrentThreadId())
    attached_threads: list[int] = []
    if foreground_thread.value and foreground_thread.value != current_thread:
        if user32.AttachThreadInput(current_thread, foreground_thread.value, True):
            attached_threads.append(foreground_thread.value)
    if thread_id != current_thread and user32.AttachThreadInput(current_thread, thread_id, True):
        attached_threads.append(thread_id)
    try:
        user32.BringWindowToTop(hwnd)
        user32.SwitchToThisWindow(hwnd, True)
        user32.SetActiveWindow(hwnd)
        user32.SetFocus(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        for attached_thread in reversed(attached_threads):
            user32.AttachThreadInput(current_thread, attached_thread, False)
    time.sleep(0.15)
    gui_info = _windows_gui_thread_info(user32, thread_id)
    if int(user32.GetForegroundWindow() or 0) != hwnd and not (
        gui_info["active"] == hwnd or gui_info["focus"] == hwnd
    ):
        raise StepError(
            "native_windows_ime_keys: QA application did not receive GUI focus "
            f"(expected=0x{hwnd:x}, foreground={_windows_foreground_info(user32)}, "
            f"thread={gui_info})"
        )
    return hwnd, thread_id


def _windows_gui_thread_info(user32: Any, thread_id: int) -> dict[str, Any]:
    user32.GetGUIThreadInfo.argtypes = [wintypes.DWORD, ctypes.POINTER(_WindowsGuiThreadInfo)]
    user32.GetGUIThreadInfo.restype = wintypes.BOOL
    info = _WindowsGuiThreadInfo()
    info.cbSize = ctypes.sizeof(_WindowsGuiThreadInfo)
    if not user32.GetGUIThreadInfo(thread_id, ctypes.byref(info)):
        return {"active": None, "focus": None, "flags": None}
    return {
        "active": int(info.hwndActive or 0),
        "focus": int(info.hwndFocus or 0),
        "flags": int(info.flags),
    }


def _windows_child_windows(user32: Any, hwnd: int) -> list[tuple[int, str]]:
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    children: list[tuple[int, str]] = []

    def visit(child_hwnd: int, _lparam: int) -> int:
        class_buffer = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(child_hwnd, class_buffer, len(class_buffer))
        children.append((int(child_hwnd), class_buffer.value))
        return 1

    callback = callback_type(visit)
    user32.EnumChildWindows(hwnd, callback, 0)
    return children


def _windows_ime_conversion_info(user32: Any, hwnd: int, thread_id: int) -> dict[str, Any]:
    """Read the real IMM32 state associated with the focused native control."""
    imm32 = ctypes.WinDLL("imm32", use_last_error=True)
    imm32.ImmGetContext.argtypes = [wintypes.HWND]
    imm32.ImmGetContext.restype = ctypes.c_void_p
    imm32.ImmReleaseContext.argtypes = [wintypes.HWND, ctypes.c_void_p]
    imm32.ImmReleaseContext.restype = wintypes.BOOL
    imm32.ImmGetOpenStatus.argtypes = [ctypes.c_void_p]
    imm32.ImmGetOpenStatus.restype = wintypes.BOOL
    imm32.ImmGetConversionStatus.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD),
    ]
    imm32.ImmGetConversionStatus.restype = wintypes.BOOL
    imm32.ImmGetDefaultIMEWnd.argtypes = [wintypes.HWND]
    imm32.ImmGetDefaultIMEWnd.restype = wintypes.HWND
    user32.SendMessageW.argtypes = [
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    user32.SendMessageW.restype = ctypes.c_ssize_t

    gui_info = _windows_gui_thread_info(user32, thread_id)
    children = _windows_child_windows(user32, int(hwnd))
    candidates = [int(gui_info.get("focus") or 0), int(hwnd)]
    candidates.extend(child_hwnd for child_hwnd, _class_name in children)
    for target_hwnd in dict.fromkeys(candidates):
        if not target_hwnd:
            continue
        context = imm32.ImmGetContext(target_hwnd)
        if not context:
            continue
        try:
            conversion = wintypes.DWORD()
            sentence = wintypes.DWORD()
            status_read = bool(
                imm32.ImmGetConversionStatus(
                    context,
                    ctypes.byref(conversion),
                    ctypes.byref(sentence),
                )
            )
            return {
                "available": True,
                "source": "imm-context",
                "window": f"0x{target_hwnd:x}",
                "open": bool(imm32.ImmGetOpenStatus(context)),
                "conversionStatusRead": status_read,
                "conversionMode": f"0x{conversion.value:x}" if status_read else None,
                "sentenceMode": f"0x{sentence.value:x}" if status_read else None,
                "nativeMode": bool(status_read and conversion.value & 0x0001),
                "windowClass": next(
                    (class_name for child_hwnd, class_name in [(target_hwnd, ""), *children]
                     if child_hwnd == target_hwnd),
                    None,
                ),
            }
        finally:
            imm32.ImmReleaseContext(target_hwnd, context)
    for target_hwnd in dict.fromkeys(candidates):
        if not target_hwnd:
            continue
        ime_window = int(imm32.ImmGetDefaultIMEWnd(target_hwnd) or 0)
        if not ime_window:
            continue
        conversion = int(
            user32.SendMessageW(
                ime_window,
                _WINDOWS_WM_IME_CONTROL,
                _WINDOWS_IMC_GETCONVERSIONMODE,
                0,
            )
        )
        sentence = int(
            user32.SendMessageW(
                ime_window,
                _WINDOWS_WM_IME_CONTROL,
                _WINDOWS_IMC_GETSENTENCEMODE,
                0,
            )
        )
        open_status = int(
            user32.SendMessageW(
                ime_window,
                _WINDOWS_WM_IME_CONTROL,
                _WINDOWS_IMC_GETOPENSTATUS,
                0,
            )
        )
        return {
            "available": True,
            "source": "default-ime-window",
            "window": f"0x{target_hwnd:x}",
            "imeWindow": f"0x{ime_window:x}",
            "open": bool(open_status),
            "conversionStatusRead": True,
            "conversionMode": f"0x{conversion:x}",
            "sentenceMode": f"0x{sentence:x}",
            "nativeMode": bool(conversion & _WINDOWS_IME_CMODE_NATIVE),
        }
    return {
        "available": False,
        "source": None,
        "window": None,
        "imeWindow": None,
        "open": None,
        "conversionStatusRead": False,
        "conversionMode": None,
        "sentenceMode": None,
        "nativeMode": None,
        "candidateWindows": [
            {"hwnd": f"0x{child_hwnd:x}", "class": class_name}
            for child_hwnd, class_name in children[:32]
        ],
    }


def _windows_ime_send_control(user32: Any, ime_window: int, control: int, value: int) -> int:
    user32.SendMessageW.argtypes = [
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    user32.SendMessageW.restype = ctypes.c_ssize_t
    return int(
        user32.SendMessageW(
            ime_window,
            _WINDOWS_WM_IME_CONTROL,
            control,
            value,
        )
    )


def _windows_enable_native_ime(
    user32: Any,
    hwnd: int,
    thread_id: int,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    before = _windows_ime_conversion_info(user32, hwnd, thread_id)
    if not before.get("available") or before.get("source") != "default-ime-window":
        raise StepError(
            "native_windows_ime_keys: Windows default IME conversion state is unavailable; "
            f"observed {before!r}"
        )
    ime_window = int(str(before["imeWindow"]), 16)
    conversion_mode = int(str(before["conversionMode"]), 16)
    restore = {
        "source": before["source"],
        "ime_window": ime_window,
        "open": bool(before.get("open")),
        "conversion_mode": conversion_mode,
    }
    _windows_ime_send_control(user32, ime_window, _WINDOWS_IMC_SETOPENSTATUS, 1)
    _windows_ime_send_control(
        user32,
        ime_window,
        _WINDOWS_IMC_SETCONVERSIONMODE,
        conversion_mode | _WINDOWS_IME_CMODE_NATIVE,
    )
    after = _windows_ime_conversion_info(user32, hwnd, thread_id)
    if not after.get("available") or not after.get("nativeMode"):
        raise StepError(
            "native_windows_ime_keys: could not enable native Chinese conversion mode; "
            f"observed {after!r}"
        )
    return before, after, restore


def _windows_activate_layout(user32: Any, hwnd: int, layout_name: str) -> tuple[int, int]:
    user32.LoadKeyboardLayoutW.argtypes = [wintypes.LPCWSTR, wintypes.UINT]
    user32.LoadKeyboardLayoutW.restype = ctypes.c_void_p
    user32.GetKeyboardLayout.argtypes = [wintypes.DWORD]
    user32.GetKeyboardLayout.restype = ctypes.c_void_p
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, ctypes.c_void_p]
    user32.PostMessageW.restype = wintypes.BOOL
    prior_thread_layout = user32.GetKeyboardLayout(0)
    prior_thread_value = int(getattr(prior_thread_layout, "value", prior_thread_layout) or 0)
    target = user32.LoadKeyboardLayoutW(layout_name, _WINDOWS_KLF_ACTIVATE)
    if not target:
        raise ctypes.WinError(ctypes.get_last_error())
    target_value = int(getattr(target, "value", target) or 0)
    thread_id = wintypes.DWORD()
    if not user32.GetWindowThreadProcessId(hwnd, ctypes.byref(thread_id)):
        raise StepError("native_windows_ime_keys: could not read QA window thread")
    prior = user32.GetKeyboardLayout(thread_id.value)
    prior_value = int(getattr(prior, "value", prior) or 0)
    if not prior_value:
        prior_value = prior_thread_value
    if not user32.PostMessageW(
        hwnd,
        _WINDOWS_INPUT_LAYOUT_REQUEST,
        0,
        ctypes.c_void_p(target_value),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    time.sleep(0.3)
    return prior_value, target_value


def _windows_key_vk(key: str) -> int:
    normalized = key.strip().upper()
    if len(normalized) == 1 and normalized.isascii() and normalized.isalnum():
        return ord(normalized)
    value = _WINDOWS_VK.get(normalized)
    if value is None:
        raise StepError(
            "native_windows_ime_keys: unsupported key "
            f"{key!r}; supported letters/digits, Control/Shift chords, arrows, Enter, Escape, Tab, Space and Backspace"
        )
    return value


def _windows_send_key_event(user32: Any, vk: int, flags: int) -> None:
    user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(_WindowsInput), ctypes.c_int]
    user32.SendInput.restype = wintypes.UINT
    event = _WindowsInput()
    event.type = _WINDOWS_INPUT_KEYBOARD
    event.ki = _WindowsKeybdInput(
        wVk=vk,
        wScan=0,
        dwFlags=flags,
        time=0,
        dwExtraInfo=0,
    )
    sent = int(user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(_WindowsInput)))
    if sent != 1:
        raise ctypes.WinError(ctypes.get_last_error())
    time.sleep(0.045)


def _windows_send_keys(user32: Any, keys: list[str]) -> None:
    for key in keys:
        parts = [part.strip() for part in key.split("+") if part.strip()]
        if not parts:
            raise StepError("native_windows_ime_keys: empty key chord")
        virtual_keys = [_windows_key_vk(part) for part in parts]
        if len(virtual_keys) == 1:
            _windows_send_key_event(user32, virtual_keys[0], 0)
            _windows_send_key_event(user32, virtual_keys[0], _WINDOWS_KEYEVENTF_KEYUP)
            continue
        for virtual_key in virtual_keys[:-1]:
            _windows_send_key_event(user32, virtual_key, 0)
        _windows_send_key_event(user32, virtual_keys[-1], 0)
        _windows_send_key_event(user32, virtual_keys[-1], _WINDOWS_KEYEVENTF_KEYUP)
        for virtual_key in reversed(virtual_keys[:-1]):
            _windows_send_key_event(user32, virtual_key, _WINDOWS_KEYEVENTF_KEYUP)


def _append_windows_ime_observation(ctx: NativeStepContext, entry: dict[str, Any]) -> None:
    artifact = ctx.case_dir / "native-windows-ime-observation.json"
    observations: list[dict[str, Any]] = []
    if artifact.exists():
        try:
            loaded = json.loads(artifact.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                observations = loaded
        except (OSError, json.JSONDecodeError):
            observations = []
    observations.append({
        "platform": platform.platform(),
        "transport": "Win32 SendInput -> Windows input layout -> WebView2",
        "verifiedAtUnixMs": int(time.time() * 1000),
        **entry,
    })
    artifact.write_text(
        json.dumps(observations, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _install_windows_ime_event_observer(ctx: NativeStepContext) -> None:
    ctx.session.execute(
        "window.__QA_NATIVE_IME_EVENTS__=[];"
        "window.__QA_NATIVE_IME_EVENT_TYPES__=['compositionstart','compositionupdate',"
        "'compositionend','beforeinput','input','keydown','keyup'];"
        "window.__QA_NATIVE_IME_EVENT_RECORD__=(event)=>window.__QA_NATIVE_IME_EVENTS__.push({"
        "type:event.type,key:event.key ?? null,code:event.code ?? null,"
        "isComposing:event.isComposing ?? null,inputType:event.inputType ?? null,"
        "data:event.data ?? null,defaultPrevented:event.defaultPrevented});"
        "for(const type of window.__QA_NATIVE_IME_EVENT_TYPES__)"
        "window.addEventListener(type,window.__QA_NATIVE_IME_EVENT_RECORD__,true);"
        "return true;"
    )


def _read_windows_ime_event_observer(ctx: NativeStepContext) -> list[dict[str, Any]]:
    events = ctx.session.execute(
        "const types=window.__QA_NATIVE_IME_EVENT_TYPES__ ?? [];"
        "const record=window.__QA_NATIVE_IME_EVENT_RECORD__;"
        "for(const type of types)"
        "window.removeEventListener(type,record,true);"
        "return window.__QA_NATIVE_IME_EVENTS__ ?? [];"
    )
    return events if isinstance(events, list) else []


def _restore_windows_input_method(self: NativeStepContext) -> None:
    state = self._windows_ime_state
    if state is None:
        return
    self._windows_ime_state = None
    user32 = _windows_user32()
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, ctypes.c_void_p]
    user32.PostMessageW.restype = wintypes.BOOL
    user32.ActivateKeyboardLayout.argtypes = [ctypes.c_void_p, wintypes.UINT]
    user32.ActivateKeyboardLayout.restype = ctypes.c_void_p
    hwnd = int(state["hwnd"])
    prior_hkl = int(state["prior_hkl"])
    mode_toggles = int(state.get("mode_toggles", 0))
    ime_restore = state.get("ime_restore")
    restored = False
    ime_restored = ime_restore is None
    error: str | None = None
    try:
        if isinstance(ime_restore, dict):
            ime_window = int(ime_restore["ime_window"])
            _windows_ime_send_control(
                user32,
                ime_window,
                _WINDOWS_IMC_SETCONVERSIONMODE,
                int(ime_restore["conversion_mode"]),
            )
            _windows_ime_send_control(
                user32,
                ime_window,
                _WINDOWS_IMC_SETOPENSTATUS,
                1 if ime_restore["open"] else 0,
            )
            ime_restored = True
        if mode_toggles % 2:
            _windows_send_keys(user32, ["Shift"])
        if prior_hkl:
            if not user32.PostMessageW(
                hwnd,
                _WINDOWS_INPUT_LAYOUT_REQUEST,
                0,
                ctypes.c_void_p(prior_hkl),
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            runner_layout = user32.ActivateKeyboardLayout(ctypes.c_void_p(prior_hkl), 0)
            restored = bool(runner_layout)
            if not restored:
                raise ctypes.WinError(ctypes.get_last_error())
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
    _append_windows_ime_observation(self, {
        "action": "restore",
        "layout": state["layout"],
        "prior_hkl": f"0x{prior_hkl:x}" if prior_hkl else None,
        "modeTogglesRestored": mode_toggles,
        "imeRestored": ime_restored,
        "restored": restored,
        "error": error,
    })


NativeStepContext._restore_windows_input_method = _restore_windows_input_method


@_verb("native_windows_ime_keys")
def _do_native_windows_ime_keys(ctx: NativeStepContext, args: Any) -> str:
    """Inject real Windows keyboard input through a configured IME layout.

    The runner never fabricates composition events. It activates the requested
    layout for the packaged QA window, sends Win32 key input, and leaves the
    DOM/native postcondition to the testcase. The prior layout and any odd
    number of explicit Shift mode toggles are restored by NativeStepContext
    teardown, including failed runs.
    """
    if platform.system() != "Windows":
        raise StepError("native_windows_ime_keys: requires Windows")
    if not isinstance(args, dict) or "selector" not in args or "keys" not in args:
        raise StepError("native_windows_ime_keys: expected {selector, layout?, keys, label?}")
    selector = str(args["selector"])
    keys = args["keys"]
    layout = str(args.get("layout", "00000804"))
    label = str(args.get("label", "keys"))
    if not selector or not isinstance(keys, list) or not keys or not all(isinstance(key, str) for key in keys):
        raise StepError("native_windows_ime_keys: selector and non-empty string keys are required")
    focused = ctx.session.execute(
        f"const el = document.querySelector({json.dumps(selector)});"
        "return !!el && (document.activeElement === el || el.contains(document.activeElement));"
    )
    if not focused:
        raise StepError(
            f"native_windows_ime_keys: target must already have DOM focus: {selector}"
        )

    user32 = _windows_user32()
    before = _windows_foreground_info(user32)
    if ctx._windows_ime_state is None:
        hwnd, _thread_id = _windows_application_window(ctx.session.application)
        prior_hkl, target_hkl = _windows_activate_layout(user32, hwnd, layout)
        ctx._windows_ime_state = {
            "hwnd": hwnd,
            "thread_id": _thread_id,
            "layout": layout,
            "prior_hkl": prior_hkl,
            "target_hkl": target_hkl,
            "mode_toggles": 0,
        }
        ime_setup_before, ime_setup_after, ime_restore = _windows_enable_native_ime(
            user32,
            hwnd,
            _thread_id,
        )
        ctx._windows_ime_state["ime_restore"] = ime_restore
    else:
        ime_setup_before = None
        ime_setup_after = None
        state = ctx._windows_ime_state
        if layout != state["layout"]:
            raise StepError(
                "native_windows_ime_keys: changing layout during one composition session "
                "would invalidate the native IME boundary"
            )
        hwnd = int(state["hwnd"])
        target_hkl = int(state["target_hkl"])

    ime_before = _windows_ime_conversion_info(user32, hwnd, int(ctx._windows_ime_state["thread_id"]))
    _install_windows_ime_event_observer(ctx)
    _windows_send_keys(user32, keys)
    if ctx._windows_ime_state is not None:
        ctx._windows_ime_state["mode_toggles"] += sum(
            1 for key in keys if key.strip().upper() == "SHIFT"
        )
    time.sleep(0.5)
    observed_events = _read_windows_ime_event_observer(ctx)
    document_observation = ctx.session.execute(
        f"const el=document.querySelector({json.dumps(selector)});"
        "return {snapshot:el?.taomniDocumentSnapshot ?? null,"
        "lines:el ? Array.from(el.querySelectorAll('.cm-line')).map(line=>line.textContent) : []};"
    )
    after = _windows_foreground_info(user32)
    ime_after = _windows_ime_conversion_info(user32, hwnd, int(ctx._windows_ime_state["thread_id"]))
    _append_windows_ime_observation(ctx, {
        "action": label,
        "selector": selector,
        "layout": layout,
        "target_hkl": f"0x{target_hkl:x}",
        "keys": keys,
        "foreground_before": before,
        "foreground_after": after,
        "ime_before": ime_before,
        "ime_after": ime_after,
        "ime_setup_before": ime_setup_before,
        "ime_setup_after": ime_setup_after,
        "observed_events": observed_events,
        "document_observation": document_observation,
        "result": "Win32 keys injected; testcase DOM postcondition is authoritative",
    })
    return f"injected {len(keys)} Windows IME keys through layout {layout}"


@_verb("assert_native_process_delta")
def _do_assert_native_process_delta(ctx: NativeStepContext, args: Any) -> str:
    return _assert_native_process_delta(ctx, args)


@_verb("native_editor_performance")
def _do_native_editor_performance(ctx: NativeStepContext, args: Any) -> str:
    return _native_editor_performance(ctx, args)


@_verb("native_click")
def _do_native_click(ctx: NativeStepContext, args: Any) -> str:
    """Click a visible control through X11 in the exact test application."""
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native_click: requires a Linux X11 display")
    if not isinstance(args, dict) or not isinstance(args.get("selector"), str):
        raise StepError("native_click: expected {selector}")
    selector = args["selector"]
    geometry = ctx.session.execute(
        f"const el = document.querySelector({json.dumps(selector)});"
        "if (!(el instanceof HTMLElement)) return null;"
        "const rect = el.getBoundingClientRect();"
        "return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,"
        "innerWidth:window.innerWidth,innerHeight:window.innerHeight,"
        "disabled:'disabled' in el ? !!el.disabled : false};"
    )
    if not isinstance(geometry, dict):
        raise StepError(f"native_click: selector not found: {selector}")
    if geometry.get("disabled"):
        raise StepError(f"native_click: target is disabled: {selector}")
    required = ("x", "y", "width", "height", "innerWidth", "innerHeight")
    if any(not isinstance(geometry.get(name), (int, float)) for name in required):
        raise StepError(f"native_click: invalid element geometry for {selector}")
    if geometry["width"] <= 0 or geometry["height"] <= 0:
        raise StepError(f"native_click: target has no visible area: {selector}")

    window_id, window_identity = _activate_x11_application(ctx.session.application)
    coordinates = ctx.session.pointer_click(selector)
    time.sleep(0.5)

    postcondition = ctx.session.execute(
        "const el = document.activeElement;"
        "return {activeTestId:el?.getAttribute('data-testid') ?? null,"
        "checked:el instanceof HTMLInputElement ? el.checked : null};"
    )
    artifact = {
        "platform": platform.platform(),
        "display": os.environ.get("DISPLAY"),
        "active_window": window_id,
        "window_identity": window_identity,
        "selector": selector,
        "css_geometry": geometry,
        "viewport_coordinates": coordinates,
        "transport": "W3C pointer actions -> packaged WebKitGTK session",
        "result": "pointer-click-injected; testcase DOM postcondition is authoritative",
        "postcondition": postcondition,
    }
    (ctx.case_dir / "native-pointer-observation.json").write_text(
        json.dumps(artifact, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return f"injected X11 pointer click into {selector}"


@_verb("native_pointer_drag")
def _do_native_pointer_drag(ctx: NativeStepContext, args: Any) -> str:
    """Drag between CodeMirror line/column coordinates in the packaged app."""
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native_pointer_drag: requires a Linux X11 display")
    if not isinstance(args, dict) or not isinstance(args.get("selector"), str):
        raise StepError(
            "native_pointer_drag: expected {selector, from:{line,column}, "
            "to:{line,column}, modifiers?}"
        )
    selector = args["selector"]
    start = args.get("from")
    end = args.get("to")
    modifiers = args.get("modifiers", [])
    if not all(isinstance(point, dict) for point in (start, end)):
        raise StepError("native_pointer_drag: from/to must be line/column objects")
    for label, point in (("from", start), ("to", end)):
        if not isinstance(point.get("line"), int) or point["line"] < 1:
            raise StepError(f"native_pointer_drag: {label}.line must be >= 1")
        if not isinstance(point.get("column"), int) or point["column"] < 0:
            raise StepError(f"native_pointer_drag: {label}.column must be >= 0")
    if not isinstance(modifiers, list) or any(
        modifier not in {"Alt", "Control", "Meta", "Shift"} for modifier in modifiers
    ):
        raise StepError(
            "native_pointer_drag: modifiers must contain only Alt/Control/Meta/Shift"
        )

    geometry = ctx.session.execute(
        f"const root = document.querySelector({json.dumps(selector)});"
        "if (!(root instanceof HTMLElement)) return null;"
        "const lines = Array.from(root.querySelectorAll('.cm-line'));"
        f"const points = {json.dumps([start, end])};"
        "const locate = ({line,column}) => {"
        " const el = lines[line - 1];"
        " if (!(el instanceof HTMLElement) || column > (el.textContent?.length ?? 0)) return null;"
        " const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);"
        " let node = walker.nextNode(), remaining = column;"
        " while (node && remaining > (node.textContent?.length ?? 0)) {"
        "  remaining -= node.textContent?.length ?? 0; node = walker.nextNode();"
        " }"
        " if (!(node instanceof Text)) return null;"
        " const range = document.createRange();"
        " range.setStart(node, remaining); range.collapse(true);"
        " const caret = range.getClientRects()[0] ?? range.getBoundingClientRect();"
        " const lineRect = el.getBoundingClientRect();"
        " return {x:Math.round(caret.x), y:Math.round(lineRect.y + lineRect.height / 2),"
        "  lineLength:el.textContent?.length ?? 0};"
        "};"
        "const resolved = points.map(locate);"
        "if (resolved.some(point => point === null)) return null;"
        "return {start:resolved[0],end:resolved[1],lineCount:lines.length,"
        " innerWidth:window.innerWidth,innerHeight:window.innerHeight};"
    )
    if not isinstance(geometry, dict):
        raise StepError(
            "native_pointer_drag: selector or requested line/column geometry is unavailable"
        )
    resolved_start = geometry.get("start")
    resolved_end = geometry.get("end")
    if not all(isinstance(point, dict) for point in (resolved_start, resolved_end)):
        raise StepError("native_pointer_drag: invalid resolved geometry")
    for point in (resolved_start, resolved_end):
        if not all(isinstance(point.get(axis), (int, float)) for axis in ("x", "y")):
            raise StepError("native_pointer_drag: invalid viewport coordinates")

    window_id, window_identity = _activate_x11_application(ctx.session.application)
    coordinates = ctx.session.pointer_drag(resolved_start, resolved_end, modifiers)
    time.sleep(0.5)
    postcondition = ctx.session.execute(
        f"const root = document.querySelector({json.dumps(selector)});"
        "return {focused:document.activeElement === root,"
        " selectionRectCount:root?.parentElement?.querySelectorAll('.cm-selectionBackground').length ?? 0,"
        " cursorCount:root?.parentElement?.querySelectorAll('.cm-cursor').length ?? 0};"
    )
    artifact = {
        "platform": platform.platform(),
        "display": os.environ.get("DISPLAY"),
        "active_window": window_id,
        "window_identity": window_identity,
        "selector": selector,
        "requested": {"from": start, "to": end, "modifiers": modifiers},
        "resolved": {
            "coordinates": coordinates,
            "fromLineLength": resolved_start.get("lineLength"),
            "toLineLength": resolved_end.get("lineLength"),
        },
        "transport": "W3C modifier + pointer actions -> packaged WebKitGTK session",
        "result": "pointer-drag-injected; testcase DOM postcondition is authoritative",
        "postcondition": postcondition,
    }
    (ctx.case_dir / "native-pointer-drag-observation.json").write_text(
        json.dumps(artifact, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return (
        f"dragged {selector} from line {start['line']} column {start['column']} "
        f"to line {end['line']} column {end['column']}"
    )


@_verb("native_ime_keys")
def _do_native_ime_keys(ctx: NativeStepContext, args: Any) -> str:
    """Inject physical X11 keys through the configured fcitx5 engine.

    This is native Linux IME evidence. W3C WebDriver keys and browser
    composition events deliberately do not enter this path.
    """
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native_ime_keys: requires a Linux X11 display")
    if not isinstance(args, dict):
        raise StepError("native_ime_keys: expected {selector, expected_engine, keys}")
    selector = args.get("selector")
    expected_engine = args.get("expected_engine")
    keys = args.get("keys")
    if not isinstance(selector, str) or not selector:
        raise StepError("native_ime_keys: selector must be a non-empty string")
    if not isinstance(expected_engine, str) or not expected_engine:
        raise StepError("native_ime_keys: expected_engine must be a non-empty string")
    if not isinstance(keys, list) or not keys or not all(isinstance(key, str) for key in keys):
        raise StepError("native_ime_keys: keys must be a non-empty string array")

    focused = ctx.session.execute(
        f"const el = document.querySelector({json.dumps(selector)});"
        "return !!el && (document.activeElement === el || el.contains(document.activeElement));"
    )
    if not focused:
        raise StepError(
            f"native_ime_keys: target must already have DOM focus before native injection: {selector}"
        )
    time.sleep(0.25)
    window_id, window_identity = _activate_x11_application(ctx.session.application)
    prior_state = _command_output(["fcitx5-remote"])
    prior_engine = _command_output(["fcitx5-remote", "-n"])

    try:
        if prior_engine != expected_engine:
            _command_output(["fcitx5-remote", "-s", expected_engine])
            time.sleep(0.25)
        engine = _command_output(["fcitx5-remote", "-n"])
        if engine != expected_engine:
            raise StepError(
                f"native_ime_keys: could not select engine {expected_engine!r}; current {engine!r}"
            )
        if prior_state != "2":
            _command_output(["fcitx5-remote", "-o"])
            time.sleep(0.25)
        if _command_output(["fcitx5-remote"]) != "2":
            raise StepError("native_ime_keys: fcitx5 did not enter active state")
        _inject_x11_keys(keys)
        time.sleep(0.5)
        artifact = {
            "platform": platform.platform(),
            "display": os.environ.get("DISPLAY"),
            "engine": engine,
            "active_window": window_id,
            "window_identity": window_identity,
            "keys": keys,
            "transport": "X11 XTest -> fcitx5 -> GTK/WebKitGTK",
            "result": "keys-injected; testcase DOM postcondition is authoritative",
        }
        (ctx.case_dir / "native-ime-observation.json").write_text(
            json.dumps(artifact, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    finally:
        if prior_engine != expected_engine:
            subprocess.run(["fcitx5-remote", "-s", prior_engine], check=False)
        if prior_state != "2":
            subprocess.run(["fcitx5-remote", "-c"], check=False)
    return f"injected {len(keys)} X11 keys through fcitx5 engine {engine}"


@_verb("native_clipboard_owner")
def _do_native_clipboard_owner(ctx: NativeStepContext, args: Any) -> str:
    """Drive an external X11 CLIPBOARD selection owner.

    actions:
      grant   - own the CLIPBOARD selection with `text`, so the app's next read
                genuinely crosses the OS boundary and returns that value.
      deny    - replace the text owner with one that advertises standard text
                targets but rejects their conversion, so clients fail immediately.
      suspend - SIGSTOP the owner. It keeps the selection but stops answering
                SelectionRequest, so every client's read fails after the X11
                timeout. This is a real OS-level clipboard denial, not a stub.
      resume  - resume a suspended owner or replace a denying owner with a text
                owner carrying the last granted payload; reads succeed again.
      release - terminate the owner and record the host-selection replacement.
    """
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native_clipboard_owner: requires a Linux X11 display")
    if not isinstance(args, dict) or "action" not in args:
        raise StepError("native_clipboard_owner: expected {action, text?}")
    action = str(args["action"])
    if action not in {"grant", "deny", "suspend", "resume", "release"}:
        raise StepError(f"native_clipboard_owner: unsupported action {action!r}")

    if action == "grant":
        text = args.get("text")
        if not isinstance(text, str) or not text:
            raise StepError("native_clipboard_owner: grant requires a non-empty text")
        if not ctx._host_clipboard_captured:
            # Snapshot metadata for the developer's real selection exactly once
            # so teardown can disclose its replacement without retaining text.
            before = _read_x11_clipboard(timeout=15.0)
            ctx._host_clipboard_before = before.get("text") if before.get("ok") else None
            ctx._host_clipboard_captured = True
        ctx._release_clipboard_owner()
        owner = _spawn_clipboard_owner(text)
        _GRANTED_CLIPBOARD_TEXTS.add(text)
        ctx._clipboard_owner = owner
        ctx._clipboard_owner_suspended = False
        ctx._clipboard_owner_mode = "grant"
        ctx._clipboard_owner_text = text
        observed = _read_x11_clipboard(timeout=20.0)
        if not observed.get("ok") or observed.get("text") != text:
            ctx._release_clipboard_owner()
            raise StepError(
                "native_clipboard_owner: grant postcondition failed; external read returned "
                f"{observed!r}"
            )
        _append_clipboard_observation(ctx, {
            "action": action,
            "ownerPid": owner.pid,
            "grantedLength": len(text),
            "externalReadOk": True,
        })
        return f"external X11 owner {owner.pid} holds CLIPBOARD ({len(text)} chars)"

    owner = ctx._clipboard_owner
    if action == "release":
        ctx._release_clipboard_owner()
        ctx._clipboard_owner_text = None
        ctx._restore_host_clipboard()
        _append_clipboard_observation(ctx, {"action": action, "ownerPid": owner.pid if owner else None})
        return "external X11 clipboard owner released; host selection replacement recorded"

    if owner is None:
        raise StepError(f"native_clipboard_owner: {action} requires a granted owner")
    if owner.poll() is not None:
        raise StepError(f"native_clipboard_owner: owner exited with {owner.returncode}")

    if action == "deny":
        if ctx._clipboard_owner_mode != "grant" or ctx._clipboard_owner_suspended:
            raise StepError("native_clipboard_owner: deny requires an active granted owner")
        granted_text = ctx._clipboard_owner_text
        if granted_text is None:
            raise StepError("native_clipboard_owner: deny has no granted payload to preserve")
        ctx._release_clipboard_owner()
        denying_owner = _spawn_clipboard_owner(deny_text_conversion=True)
        ctx._clipboard_owner = denying_owner
        ctx._clipboard_owner_mode = "deny"
        probe = _read_x11_clipboard(timeout=5.0)
        if probe.get("ok"):
            ctx._release_clipboard_owner()
            raise StepError(
                "native_clipboard_owner: deny exposed a readable text target; external read "
                f"succeeded with {probe.get('text')!r}"
            )
        _append_clipboard_observation(ctx, {
            "action": action,
            "ownerPid": denying_owner.pid,
            "ownerMode": "text-targets-reject-conversion",
            "preservedGrantLength": len(granted_text),
            "externalReadOk": False,
            "externalReadError": probe.get("error"),
        })
        return (
            f"owner {denying_owner.pid} denies X11 text conversion; "
            f"external X11 read denied ({probe.get('error')})"
        )

    if action == "suspend":
        if ctx._clipboard_owner_mode != "grant":
            raise StepError("native_clipboard_owner: suspend requires an active granted owner")
        os.kill(owner.pid, signal.SIGSTOP)
        ctx._clipboard_owner_suspended = True
        time.sleep(0.3)
        state = _process_state(owner.pid)
        if state not in {"T", "t"}:
            raise StepError(
                f"native_clipboard_owner: owner {owner.pid} did not stop (state={state!r})"
            )
        # Prove the denial is real before the app is asked to read: an external
        # client must also fail against this owner.
        probe = _read_x11_clipboard(timeout=20.0)
        if probe.get("ok"):
            raise StepError(
                "native_clipboard_owner: suspend did not deny X11 reads; external read still "
                f"succeeded with {probe.get('text')!r}"
            )
        _append_clipboard_observation(ctx, {
            "action": action,
            "ownerPid": owner.pid,
            "ownerProcState": state,
            "externalReadOk": False,
            "externalReadError": probe.get("error"),
        })
        return f"owner {owner.pid} suspended; external X11 read denied ({probe.get('error')})"

    if ctx._clipboard_owner_mode == "deny":
        granted_text = ctx._clipboard_owner_text
        if granted_text is None:
            raise StepError("native_clipboard_owner: resume has no granted payload to restore")
        ctx._release_clipboard_owner()
        owner = _spawn_clipboard_owner(granted_text)
        ctx._clipboard_owner = owner
        ctx._clipboard_owner_mode = "grant"
        resume_mode = "replaced-denying-owner"
    else:
        if not ctx._clipboard_owner_suspended:
            raise StepError("native_clipboard_owner: resume requires a denied or suspended owner")
        os.kill(owner.pid, signal.SIGCONT)
        ctx._clipboard_owner_suspended = False
        resume_mode = "continued-suspended-owner"
        time.sleep(0.3)
    probe = _read_x11_clipboard(timeout=20.0)
    if not probe.get("ok"):
        raise StepError(
            f"native_clipboard_owner: resume did not restore X11 reads: {probe.get('error')}"
        )
    _append_clipboard_observation(ctx, {
        "action": action,
        "ownerPid": owner.pid,
        "resumeMode": resume_mode,
        "ownerProcState": _process_state(owner.pid),
        "externalReadOk": True,
    })
    return f"owner {owner.pid} resumed; external X11 read restored"


def _process_state(pid: int) -> str | None:
    try:
        stat_line = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError:
        return None
    # comm may contain spaces/parens; the state field follows the last ')'.
    tail = stat_line.rsplit(")", 1)[-1].split()
    return tail[0] if tail else None


@_verb("assert_system_clipboard")
def _do_assert_system_clipboard(ctx: NativeStepContext, args: Any) -> str:
    """Independently read the real X11 CLIPBOARD selection and assert it.

    This is the only step that can prove the app's copy actually reached the OS:
    the value is fetched by a separate process through a real X11 selection
    transfer, never from the app's DOM or its in-process clipboard state.
    """
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("assert_system_clipboard: requires a Linux X11 display")
    if not isinstance(args, dict):
        raise StepError("assert_system_clipboard: expected {equals|contains|readable}")
    keys = {"equals", "contains", "readable"} & set(args)
    if len(keys) != 1:
        raise StepError("assert_system_clipboard: pass exactly one of equals/contains/readable")

    observed = _read_x11_clipboard(timeout=float(args.get("timeout_sec", 30.0)))
    ok = bool(observed.get("ok"))
    text = observed.get("text") if ok else None

    if "readable" in args:
        expected_readable = bool(args["readable"])
        if ok != expected_readable:
            raise StepError(
                f"assert_system_clipboard: expected readable={expected_readable}, observed "
                f"ok={ok} error={observed.get('error')!r}"
            )
        summary = f"readable={ok}"
    else:
        if not ok:
            raise StepError(
                f"assert_system_clipboard: external X11 read failed: {observed.get('error')}"
            )
        if "equals" in args:
            expected = str(args["equals"])
            if text != expected:
                raise StepError(
                    "assert_system_clipboard: OS clipboard mismatch; expected "
                    f"{expected!r} of {len(expected)} chars, observed {len(text or '')} chars"
                )
            summary = f"equals {len(expected)} chars"
        else:
            needle = str(args["contains"])
            if needle not in (text or ""):
                raise StepError(
                    f"assert_system_clipboard: OS clipboard does not contain {needle!r}"
                )
            summary = f"contains {len(needle)} chars"

    _append_clipboard_observation(ctx, {
        "action": "assert",
        "assertion": sorted(keys)[0],
        "externalReadOk": ok,
        "externalReadError": observed.get("error"),
        "observedLength": len(text) if isinstance(text, str) else None,
        "observedSha256": hashlib.sha256(text.encode("utf-8")).hexdigest()
        if isinstance(text, str) else None,
    })
    return f"external X11 CLIPBOARD assertion passed ({summary})"


@_verb("seed_storage")
def _do_seed_storage(ctx: NativeStepContext, args: Any) -> str:
    """Seed one localStorage entry (see steps/persistence.py rationale)."""
    if not isinstance(args, dict) or "key" not in args or "value" not in args:
        raise StepError("seed_storage: expected {key, value}")
    key = str(args["key"])
    value = str(args["value"])
    import json as _json
    try:
        _json.loads(value)
    except ValueError as e:
        raise StepError(f"seed_storage: value must be valid JSON ({e})") from e
    ctx.session.execute(
        f"window.localStorage.setItem({_json.dumps(key)}, {_json.dumps(value)});"
        "return window.localStorage.getItem(" + _json.dumps(key) + ") !== null;"
    )
    return f"seeded {key}"


@_verb("seed_clipboard")
def _do_seed_clipboard(ctx: NativeStepContext, args: Any) -> str:
    """Write controlled text through the packaged WebView's OS clipboard API.

    Browser mode has the same verb in ``steps.app_specific``. Native mode
    cannot call Playwright, so use the app's WebView context and wait for the
    real asynchronous clipboard promise before allowing the case to proceed.
    The subsequent production paste is the behavioral postcondition.
    """
    text = str(args)
    status_key = "__QA_UI_AUTO_CLIPBOARD_STATUS__"
    script = (
        f"window.{status_key} = 'pending'; "
        f"navigator.clipboard.writeText({json.dumps(text)}).then("
        f"() => window.{status_key} = 'ok', "
        f"(error) => window.{status_key} = 'error:' + String(error)); "
        "return true;"
    )
    try:
        ctx.session.execute(script)
    except Exception as error:  # noqa: BLE001
        raise StepError(f"seed_clipboard: native WebView write could not start ({error})") from error

    deadline = time.time() + 10
    status = None
    while time.time() < deadline:
        status = ctx.session.execute(f"return window.{status_key};")
        if status == "ok":
            return f"native WebView clipboard write completed ({len(text)} chars)"
        if isinstance(status, str) and status.startswith("error:"):
            raise StepError(f"seed_clipboard: native WebView write rejected ({status[6:]})")
        time.sleep(0.1)
    raise StepError(f"seed_clipboard: native WebView write timed out (status={status!r})")


@_verb("reload_window")
def _do_reload_window(ctx: NativeStepContext, args: Any) -> str:
    """Reload the webview document; wait for the app shell to return."""
    _ = args
    ctx.session.execute(
        "window.setTimeout(() => window.location.reload(), 0); return true;"
    )
    time.sleep(2.0)  # document teardown; execute/sync is unavailable during it
    ctx.session.find("[data-testid='welcome-panel']", timeout=60)
    # The reload dropped the console hook along with the old document.
    ctx.session.install_console_hook()
    return "reloaded; welcome-panel visible"


@_verb("vault_first_run")
def _do_vault_first_run(ctx: NativeStepContext, args: Any) -> str:
    """Complete the empty-vault first-run master-password gate.

    Fresh isolated app-data => vault.db is empty => the app shows the setup
    dialog. Fills both fields with the given QA password and confirms. If a
    LOCKED vault shows the unlock dialog instead, fail loudly: the password
    is unknown and guessing would be dishonest. If the main UI is already
    reachable, this is a no-op.
    """
    password = str(args)
    deadline = time.time() + 20
    while time.time() < deadline:
        if _find_quiet(ctx, "[data-testid='vault-setup-dialog']"):
            break
        if _find_quiet(ctx, "[data-testid='vault-unlock-dialog']"):
            raise StepError(
                "vault_first_run: vault is LOCKED with an unknown master "
                "password; run against a fresh isolated profile"
            )
        if _find_quiet(ctx, "[data-testid='welcome-panel']"):
            return "vault already unlocked; no-op"
        time.sleep(0.5)
    else:
        raise StepError("vault_first_run: neither vault dialog nor welcome-panel appeared")
    ctx.session.fill("[data-testid='vault-setup-pw1']", password)
    ctx.session.fill("[data-testid='vault-setup-pw2']", password)
    ctx.session.click("[data-testid='vault-setup-confirm']")
    ctx.session.wait_absent("[data-testid='vault-setup-dialog']", timeout=30)
    return "vault master password set"


def _find_quiet(ctx: NativeStepContext, selector: str) -> bool:
    try:
        ctx.session.find(selector, timeout=0.5)
        return True
    except Exception:  # noqa: BLE001
        return False


def run_native_step(ctx: NativeStepContext, verb: str, args: Any) -> str:
    fn = VERBS.get(verb)
    if fn is None:
        raise StepError(
            f"native runner does not support verb {verb!r}; supported: {sorted(VERBS)}"
        )
    return fn(ctx, args)
