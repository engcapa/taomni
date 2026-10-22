"""Sequential W3C HTTP ownership; no retries of uncertain native actions."""
from __future__ import annotations

import http.client
import json
from pathlib import Path
import time
from typing import Any
import urllib.error
import urllib.parse
import urllib.request


class WebDriverError(RuntimeError):
    pass


class WebDriverTransport:
    def __init__(self, driver_url: str, application: Path, on_close: Any | None = None):
        self.driver_url = driver_url.rstrip("/")
        self.application = application
        self._on_close = on_close
        self.session_id: str | None = None
        self.deadline = None
        # A local driver must remain reachable when the desktop uses a proxy.
        host = urllib.parse.urlsplit(self.driver_url).hostname
        self._local_endpoint = (urllib.parse.urlsplit(self.driver_url)
                                if host in {"localhost", "127.0.0.1", "::1"} else None)
        self._connection: http.client.HTTPConnection | None = None
        self._open = (urllib.request.build_opener(urllib.request.ProxyHandler({})).open
                      if host in {"localhost", "127.0.0.1", "::1"} else urllib.request.urlopen)
        self.last_request: dict[str, Any] = {}
        self.cleanup_diagnostics: dict[str, Any] = {}

    def request(self, method: str, path: str, payload: dict | None = None) -> Any:
        body = None
        headers = {"Content-Type": "application/json"}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.driver_url}{path}", data=body, headers=headers, method=method
        )
        started = time.monotonic()
        observation = {"method": method, "path": path, "phase": "prepare"}
        self.last_request = observation
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
                    observation["phase"] = "send_request"
                    self._connection.request(method, path, body=body, headers=headers)
                    observation["phase"] = "response_headers"
                    response = self._connection.getresponse()
                    observation["http_status"] = response.status
                    observation["phase"] = "response_body"
                    data = response.read().decode("utf-8")
                    if response.status >= 400:
                        raise WebDriverError(f"HTTP {response.status}: {data}")
                except Exception:
                    self._connection.close()
                    self._connection = None
                    # Never retry an action whose delivery is uncertain.
                    raise
            else:
                observation["phase"] = "open_response"
                with self._open(req, timeout=timeout) as r:
                    observation["phase"] = "response_body"
                    data = r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            observation["error_type"] = type(e).__name__
            detail = e.read().decode("utf-8", errors="replace")
            raise WebDriverError(f"HTTP {e.code}: {detail}") from e
        except Exception as e:
            observation["error_type"] = type(e).__name__
            raise
        else:
            observation["phase"] = "decode_response"
            if not data:
                observation["phase"] = "complete"
                return None
            try:
                parsed = json.loads(data)
                value = parsed.get("value", parsed)
                if isinstance(value, dict) and "error" in value:
                    raise WebDriverError(value.get("message") or value["error"])
            except Exception as e:
                observation["error_type"] = type(e).__name__
                raise
            observation["phase"] = "complete"
            return value
        finally:
            # Never record payloads or response bodies: execute/fill requests
            # can contain credentials. Keep only the latest command's phase.
            observation["duration_sec"] = time.monotonic() - started

    def close(self) -> None:
        from qa_ui_auto.deadline import Deadline

        diagnostics: dict[str, Any] = {"delete_attempted": bool(self.session_id)}
        self.cleanup_diagnostics = diagnostics
        try:
            if self.session_id:
                # Case/failure-capture/host-restoration budgets may already
                # be exhausted. Always give DELETE its own bounded attempt.
                self.deadline = Deadline(5)
                try:
                    self.request("DELETE", f"/session/{self.session_id}")
                finally:
                    diagnostics["delete_request"] = dict(self.last_request)
        finally:
            self.session_id = None
            if self._connection:
                self._connection.close()
                self._connection = None
            # A failed POST can leave an app even without a returned session
            # ID. The owner must release that tree too; close is idempotent.
            on_close, self._on_close = self._on_close, None
            if on_close is not None:
                started = time.monotonic()
                owner = {"status": "running"}
                diagnostics["owner_cleanup"] = owner
                try:
                    on_close()
                except Exception as e:
                    owner.update(status="failed", error_type=type(e).__name__)
                    raise
                else:
                    owner["status"] = "passed"
                finally:
                    owner["duration_sec"] = time.monotonic() - started
