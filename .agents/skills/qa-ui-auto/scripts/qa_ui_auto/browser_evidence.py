"""Passive browser diagnostics; never replace or replay terminal input."""
from __future__ import annotations

import base64
from collections import deque
from contextlib import suppress
import hashlib
import json
from pathlib import Path
import time
from typing import Any
from urllib.parse import urlparse


class BrowserEvidence:
    """Own console listeners and bounded SSH bridge frame evidence for one case.

    Playwright observes frames after the browser sends/receives them. No DOM,
    WebSocket implementation, delivery order, or product callback is changed.
    Connect/authentication frames are deliberately excluded.
    """

    FRAME_LIMIT = 128
    BYTE_LIMIT = 2048

    def __init__(self, page: Any, console: list[dict], case_dir: Path,
                 *, trace_terminal: bool = False):
        self.console = console
        self.case_dir = case_dir
        self.trace_terminal = trace_terminal
        self.started = time.monotonic()
        self.frames: deque[dict] = deque(maxlen=self.FRAME_LIMIT)
        self.sequence = 0
        self.socket_count = 0
        self.listeners: list[tuple[Any, str, Any]] = []
        self._listen(page, "console", lambda msg: console.append(
            {"level": msg.type, "text": msg.text}))
        self._listen(page, "pageerror", lambda exc: console.append(
            {"level": "error", "text": f"pageerror: {exc}"}))
        if trace_terminal:
            self._listen(page, "websocket", self._socket)

    def _listen(self, emitter: Any, event: str, handler: Any) -> None:
        emitter.on(event, handler)
        self.listeners.append((emitter, event, handler))

    def _socket(self, socket: Any) -> None:
        if urlparse(socket.url).path != "/__taomni/ssh-bridge":
            return
        self.socket_count += 1
        index = self.socket_count
        for event, direction in (("framesent", "sent"), ("framereceived", "received")):
            self._listen(socket, event, lambda payload, d=direction: self._frame(index, d, payload))

    def _frame(self, socket: int, direction: str, payload: Any) -> None:
        try:
            message = json.loads(payload)
            kind = message.get("type")
            if kind not in {"data", "output", "resize", "ready", "closed"}:
                return
            # Do not persist arbitrary keys or malformed application messages.
            frame: dict[str, Any] = {"socket": socket, "direction": direction, "type": kind}
            if kind in {"data", "output"}:
                raw = base64.b64decode(message["data"], validate=True)
                frame.update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
                if len(raw) <= self.BYTE_LIMIT:
                    frame["data_base64"] = base64.b64encode(raw).decode("ascii")
                else:
                    size = self.BYTE_LIMIT // 2
                    frame.update(head_base64=base64.b64encode(raw[:size]).decode("ascii"),
                                 tail_base64=base64.b64encode(raw[-size:]).decode("ascii"),
                                 truncated=True)
            elif kind == "resize":
                for name in ("rows", "cols"):
                    value = message[name]
                    if isinstance(value, bool) or not isinstance(value, int):
                        return
                    frame[name] = value
            self.sequence += 1
            frame.update(sequence=self.sequence, elapsed_ms=(time.monotonic() - self.started) * 1000)
            self.frames.append(frame)
        except (ValueError, TypeError, KeyError, AttributeError):
            return

    def close(self) -> None:
        for emitter, event, handler in reversed(self.listeners):
            with suppress(Exception):
                emitter.remove_listener(event, handler)
        self.listeners.clear()
        if not self.trace_terminal:
            return
        try:
            self.case_dir.joinpath("terminal-transport.json").write_text(json.dumps({
                "observation": "Passive browser SSH WebSocket frames; not native transport evidence",
                "frame_limit": self.FRAME_LIMIT, "byte_limit": self.BYTE_LIMIT,
                "total_frames": self.sequence, "sockets": self.socket_count,
                "frames": list(self.frames),
            }, indent=2) + "\n", encoding="utf-8")
        except OSError as exc:
            self.console.append({"level": "warning", "text": f"Terminal transport evidence: {exc}"})
