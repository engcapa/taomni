#!/usr/bin/env python3
"""Scriptable RFB test server for native VNC checks the shared live server cannot cover.

    python vnc_fixture_server.py --port 5988 --log events.jsonl --control-port 5989 \
        [--security none|vncauth] [--password-env VAR] [--auth-delay-ms N] \
        [--width 1280 --height 720] [--animate-fps 10] [--ext-clipboard [--clip-formats text,html]]

Every client message (keys, pointer, cut text, encodings, pixel format, update
requests) is appended to --log as one JSON line with a time.perf_counter()
stamp, so native runs can prove exactly what reached "the remote". Line
commands on the control port (one per connection or newline separated):

    resize W H      DesktopSize change (when the client advertised -223)
    cuttext TEXT    legacy ServerCutText to every client
    extclip TEXT    ExtendedClipboard notify (client requests, server provides)
    bell            Bell
    drop            close every client socket abruptly (network drop)
    freeze / thaw   stop / resume answering (hung server; sockets stay open)
    reject-auth on|off   answer the next VNCAuth attempts with failure
    auth-delay MS   delay the VNCAuth result (a slow server; 0 restores)
    stats           reply with per-client counters
    reset           drop every client and restore the start-up state
    log PATH        also append every later event to PATH (replaces the
                    previous per-case log)
    watch PATH      run PATH's lines (not '#' comments) as commands each time
                    its content changes (replaces the previous watched file)

Pixel encodings: Tight (7; fill, palette, copy/gradient filters, JPEG when a
quality level is requested and Pillow is available), ZRLE is not implemented,
Raw (0) otherwise. Any true-colour client pixel format (8/16/32 bpp) is
honoured. Screen content is synthetic; nothing private is ever served.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import select
import socket
import struct
import threading
import time
import zlib

import numpy as np

try:
    from PIL import Image
except ImportError:  # JPEG sub-encoding is optional
    Image = None

from vnc_des import vnc_auth_response

ENC_RAW = 0
ENC_COPYRECT = 1
ENC_TIGHT = 7
ENC_DESKTOP_SIZE = -223
ENC_EXT_CLIPBOARD = 0xC0A1E5CE - (1 << 32)
CLIP_CAPS, CLIP_REQUEST, CLIP_PEEK, CLIP_NOTIFY, CLIP_PROVIDE = (1 << 24, 1 << 25, 1 << 26, 1 << 27, 1 << 28)
CLIP_TEXT, CLIP_RTF, CLIP_HTML = 1, 2, 4
JPEG_QUALITY = [5, 10, 15, 25, 37, 50, 60, 70, 75, 80]
TIGHT_MAX_WIDTH = 2048
TIGHT_BAND_ROWS = 128


class EventLog:
    def __init__(self, path: str | None) -> None:
        self.lock = threading.Lock()
        self.base = open(path, "a", encoding="utf-8") if path else None
        self.case = None

    def tee(self, path: str) -> None:
        """Also append every later event to `path`, replacing the previous
        per-case log (one log per test case)."""
        with self.lock:
            if self.case:
                self.case.close()
            self.case = open(path, "a", encoding="utf-8")

    def write(self, conn: int, kind: str, **fields) -> None:
        record = {"t": round(time.perf_counter(), 6), "conn": conn, "type": kind, **fields}
        line = json.dumps(record, ensure_ascii=False)
        with self.lock:
            for handle in (self.base, self.case):
                if handle:
                    handle.write(line + "\n")
                    handle.flush()
        if kind not in ("pointer", "fbur"):
            print(line, flush=True)


class Scene:
    """Synthetic desktop shared by every client connection."""

    def __init__(self, width: int, height: int) -> None:
        self.lock = threading.Lock()
        self.clients: list["Client"] = []
        self.frame = 0
        self.resize(width, height, notify=False)

    def resize(self, width: int, height: int, notify: bool = True) -> None:
        with self.lock:
            self.width, self.height = width, height
            y, x = np.mgrid[0:height, 0:width]
            fb = np.zeros((height, width, 3), dtype=np.uint8)
            fb[..., 0] = (x * 255 // max(1, width - 1)).astype(np.uint8)
            fb[..., 1] = (y * 255 // max(1, height - 1)).astype(np.uint8)
            fb[..., 2] = 96
            fb[::32, :, :] = 40
            fb[:, ::32, :] = 40
            # A "photo" area (smooth noise) exercises JPEG, a flat panel exercises fill.
            rng = np.random.default_rng(7)
            ph, pw = height // 3, width // 3
            noise = rng.integers(0, 255, (ph // 8 + 1, pw // 8 + 1, 3), dtype=np.uint8)
            photo = np.kron(noise, np.ones((8, 8, 1), dtype=np.uint8))[:ph, :pw]
            fb[height // 3: height // 3 + ph, width // 3: width // 3 + pw] = photo
            fb[16:96, 16:320] = (230, 230, 230)
            self.fb = fb
            clients = list(self.clients)
        if notify:
            for client in clients:
                client.on_resize(width, height)

    def animate(self) -> None:
        with self.lock:
            self.frame += 1
            x = 40 + (self.frame * 12) % max(1, self.width - 140)
            y0 = self.height - 120
            self.fb[y0:y0 + 80, :, :] = (20, 20, 20)
            self.fb[y0 + 10:y0 + 70, x:x + 60, :] = (255, 180, 0)
            rect = (0, y0, self.width, 80)
            clients = list(self.clients)
        for client in clients:
            client.mark_dirty(rect)


class PixelFormat:
    def __init__(self, raw: bytes) -> None:
        (self.bpp, self.depth, big, true, self.rmax, self.gmax, self.bmax,
         self.rshift, self.gshift, self.bshift) = struct.unpack(">BBBBHHHBBB", raw[:13])
        self.big_endian = bool(big)
        self.true_colour = bool(true)

    @classmethod
    def default(cls) -> "PixelFormat":
        return cls(struct.pack(">BBBBHHHBBB", 32, 24, 0, 1, 255, 255, 255, 16, 8, 0) + b"\0\0\0")

    def describe(self) -> dict:
        return {"bpp": self.bpp, "depth": self.depth, "big_endian": self.big_endian,
                "true_colour": self.true_colour, "max": [self.rmax, self.gmax, self.bmax],
                "shift": [self.rshift, self.gshift, self.bshift]}

    def tpixel24(self) -> bool:
        return (self.bpp == 32 and self.depth == 24 and self.true_colour
                and (self.rmax, self.gmax, self.bmax) == (255, 255, 255))

    def pixels(self, rgb: np.ndarray) -> np.ndarray:
        """Pack an (N, 3) uint8 array into client pixel values (uint32)."""
        r = rgb[:, 0].astype(np.uint32) * self.rmax // 255
        g = rgb[:, 1].astype(np.uint32) * self.gmax // 255
        b = rgb[:, 2].astype(np.uint32) * self.bmax // 255
        return (r << self.rshift) | (g << self.gshift) | (b << self.bshift)

    def pack(self, rgb: np.ndarray) -> bytes:
        values = self.pixels(rgb.reshape(-1, 3))
        order = ">" if self.big_endian else "<"
        if self.bpp == 32:
            return values.astype(order + "u4").tobytes()
        if self.bpp == 16:
            return values.astype(order + "u2").tobytes()
        return values.astype("u1").tobytes()

    def tpack(self, rgb: np.ndarray) -> bytes:
        if self.tpixel24():
            return np.ascontiguousarray(rgb.reshape(-1, 3)).tobytes()
        return self.pack(rgb)


def compact_length(n: int) -> bytes:
    out = bytearray([n & 0x7F])
    if n > 0x7F:
        out[0] |= 0x80
        out.append((n >> 7) & 0x7F)
        if n > 0x3FFF:
            out[1] |= 0x80
            out.append((n >> 14) & 0xFF)
    return bytes(out)


class TightEncoder:
    def __init__(self) -> None:
        self.streams = [zlib.compressobj(6) for _ in range(4)]
        self.level = 6
        self.quality: int | None = None
        self.gradient = False
        # Fresh compressors: tell the client to reset its inflaters as well.
        self.reset_pending = 0x0F

    def set_level(self, level: int) -> None:
        if level != self.level:
            self.level = level
            self.streams = [zlib.compressobj(max(1, level)) for _ in range(4)]
            self.reset_pending = 0x0F

    def _zlib(self, stream: int, data: bytes) -> bytes:
        if len(data) < 12:
            return data
        packed = self.streams[stream].compress(data) + self.streams[stream].flush(zlib.Z_SYNC_FLUSH)
        return compact_length(len(packed)) + packed

    def encode(self, pf: PixelFormat, rgb: np.ndarray) -> bytes:
        h, w = rgb.shape[:2]
        reset, self.reset_pending = self.reset_pending, 0
        flat = rgb.reshape(-1, 3)
        colours = np.unique(flat.view(np.dtype((np.void, 3))))
        if len(colours) == 1:
            return bytes([reset | 0x80]) + pf.tpack(flat[:1])
        if self.quality is not None and Image is not None and pf.bpp in (16, 32) and w * h >= 64:
            buf = io.BytesIO()
            Image.fromarray(rgb, "RGB").save(buf, "JPEG", quality=JPEG_QUALITY[self.quality])
            data = buf.getvalue()
            return bytes([reset | 0x90]) + compact_length(len(data)) + data
        if len(colours) <= 256:
            palette = np.frombuffer(colours.tobytes(), dtype=np.uint8).reshape(-1, 3)
            keys = flat[:, 0].astype(np.uint32) << 16 | flat[:, 1].astype(np.uint32) << 8 | flat[:, 2]
            pkeys = palette[:, 0].astype(np.uint32) << 16 | palette[:, 1].astype(np.uint32) << 8 | palette[:, 2]
            index = np.searchsorted(pkeys, keys).astype(np.uint8).reshape(h, w)
            head = bytes([reset | 0x40 | (1 << 4), 1, len(palette) - 1]) + pf.tpack(palette)
            if len(palette) == 2:
                data = np.packbits(index.astype(bool), axis=1).tobytes()
            else:
                data = index.tobytes()
            return head + self._zlib(1, data)
        if self.gradient and pf.bpp in (16, 32):
            return bytes([reset | 0x40 | (2 << 4), 2]) + self._zlib(2, gradient_filter(pf, rgb))
        return bytes([reset]) + self._zlib(0, pf.tpack(rgb))


def gradient_filter(pf: PixelFormat, rgb: np.ndarray) -> bytes:
    """Tight gradient filter over TPIXEL components (prediction = left + up - upleft)."""
    if pf.tpixel24():
        comps = rgb.astype(np.int32)
        maxes = (255, 255, 255)
    else:
        values = pf.pixels(rgb.reshape(-1, 3)).reshape(rgb.shape[:2])
        comps = np.stack([(values >> pf.rshift) & pf.rmax, (values >> pf.gshift) & pf.gmax,
                          (values >> pf.bshift) & pf.bmax], axis=-1).astype(np.int32)
        maxes = (pf.rmax, pf.gmax, pf.bmax)
    h, w = comps.shape[:2]
    padded = np.zeros((h + 1, w + 1, 3), dtype=np.int32)
    padded[1:, 1:] = comps
    left, up, upleft = padded[1:, :-1], padded[:-1, 1:], padded[:-1, :-1]
    pred = np.clip(left + up - upleft, 0, np.array(maxes))
    diff = (comps - pred) & np.array(maxes)
    if pf.tpixel24():
        return diff.astype(np.uint8).tobytes()
    packed = (diff[..., 0].astype(np.uint32) << pf.rshift) | (diff[..., 1].astype(np.uint32) << pf.gshift) \
        | (diff[..., 2].astype(np.uint32) << pf.bshift)
    order = ">" if pf.big_endian else "<"
    return packed.astype(order + ("u4" if pf.bpp == 32 else "u2")).tobytes()


class Server:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.log = EventLog(args.log)
        self.scene = Scene(args.width, args.height)
        self.frozen = threading.Event()
        self.reject_auth = args.reject_auth
        self.auth_delay_ms = args.auth_delay_ms
        self.watch_path: str | None = None
        self.password = os.environ.get(args.password_env, "") if args.password_env else ""
        names = {"text": CLIP_TEXT, "rtf": CLIP_RTF, "html": CLIP_HTML}
        self.clip_formats = 0
        for name in args.clip_formats.split(","):
            self.clip_formats |= names[name.strip()]
        self.counter = 0
        self.counter_lock = threading.Lock()

    def next_id(self) -> int:
        with self.counter_lock:
            self.counter += 1
            return self.counter


class Client:
    def __init__(self, server: Server, sock: socket.socket) -> None:
        self.server = server
        self.sock = sock
        self.id = server.next_id()
        self.log = server.log
        self.pf = PixelFormat.default()
        self.encodings: list[int] = []
        self.tight = TightEncoder()
        self.cond = threading.Condition()
        self.pending_request: tuple[bool, int, int, int, int] | None = None
        self.dirty: list[tuple[int, int, int, int]] = []
        self.pending_resize: tuple[int, int] | None = None
        self.outbox: list[bytes] = []
        self.closed = False
        self.send_lock = threading.Lock()
        self.bytes_sent = 0
        self.updates_sent = 0

    # ── helpers ────────────────────────────────────────────────────────
    def recv_exact(self, n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("client closed")
            buf += chunk
        return bytes(buf)

    def send(self, data: bytes) -> None:
        with self.send_lock:
            self.sock.sendall(data)
            self.bytes_sent += len(data)

    def wait_or_closed(self, seconds: float) -> bool:
        """Sleep like a slow server but notice the client hanging up; False if it did."""
        end = time.time() + seconds
        while time.time() < end:
            readable, _, _ = select.select([self.sock], [], [], min(0.05, max(0.0, end - time.time())))
            if readable:
                try:
                    if not self.sock.recv(1, socket.MSG_PEEK):
                        return False
                except OSError:
                    return False
                time.sleep(0.05)
        return True

    def mark_dirty(self, rect) -> None:
        with self.cond:
            self.dirty.append(rect)
            self.cond.notify_all()

    def on_resize(self, width: int, height: int) -> None:
        with self.cond:
            self.pending_resize = (width, height)
            self.dirty = [(0, 0, width, height)]
            self.cond.notify_all()

    def queue(self, message: bytes) -> None:
        with self.cond:
            self.outbox.append(message)
            self.cond.notify_all()

    # ── handshake ──────────────────────────────────────────────────────
    def handshake(self) -> bool:
        args = self.server.args
        self.send(f"RFB 003.{args.version:03d}\n".encode())
        client_version = self.recv_exact(12).decode("latin-1").strip()
        minor = int(client_version[-3:]) if client_version.startswith("RFB 003.") else 3
        sec = 2 if args.security == "vncauth" else 1
        if minor < 7:
            self.send(struct.pack(">I", sec))
        else:
            self.send(bytes([1, sec]))
            chosen = self.recv_exact(1)[0]
            if chosen != sec:
                self.log.write(self.id, "auth", ok=False, reason=f"client chose {chosen}")
                return False
        ok = True
        if sec == 2:
            challenge = os.urandom(16)
            self.send(challenge)
            response = self.recv_exact(16)
            if self.server.auth_delay_ms and not self.wait_or_closed(self.server.auth_delay_ms / 1000.0):
                self.log.write(self.id, "disconnect", reason="client closed during auth delay")
                return False
            ok = not self.server.reject_auth and response == vnc_auth_response(self.server.password, challenge)
        if sec == 2 or minor >= 8:
            if ok:
                self.send(struct.pack(">I", 0))
            else:
                reason = b"Authentication failed"
                self.send(struct.pack(">I", 1) + (struct.pack(">I", len(reason)) + reason if minor >= 8 else b""))
        self.log.write(self.id, "auth", ok=ok, security="VNCAuth" if sec == 2 else "None", client_version=client_version)
        if not ok:
            return False
        shared = self.recv_exact(1)[0]
        scene = self.server.scene
        name = args.name.encode()
        pf = struct.pack(">BBBBHHHBBB", 32, 24, 0, 1, 255, 255, 255, 16, 8, 0) + b"\0\0\0"
        self.send(struct.pack(">HH", scene.width, scene.height) + pf + struct.pack(">I", len(name)) + name)
        self.log.write(self.id, "client_init", shared=bool(shared), width=scene.width, height=scene.height)
        return True

    # ── reader ─────────────────────────────────────────────────────────
    def read_loop(self) -> None:
        while True:
            kind = self.recv_exact(1)[0]
            if kind == 0:
                raw = self.recv_exact(19)
                self.pf = PixelFormat(raw[3:])
                self.tight = TightEncoder()
                self.log.write(self.id, "set_pixel_format", **self.pf.describe())
                with self.cond:
                    self.dirty = [(0, 0, self.server.scene.width, self.server.scene.height)]
            elif kind == 2:
                _, count = struct.unpack(">BH", self.recv_exact(3))
                self.encodings = list(struct.unpack(f">{count}i", self.recv_exact(4 * count)))
                quality = [e + 32 for e in self.encodings if -32 <= e <= -23]
                level = [e + 256 for e in self.encodings if -256 <= e <= -247]
                self.tight.quality = quality[0] if quality else None
                self.tight.set_level(level[0] if level else 6)
                self.log.write(self.id, "set_encodings", encodings=self.encodings)
                if ENC_EXT_CLIPBOARD in self.encodings and self.server.args.ext_clipboard:
                    formats = self.server.clip_formats
                    sizes = [16 * 1024 * 1024] * bin(formats).count("1")
                    body = struct.pack(f">I{len(sizes)}I", CLIP_CAPS | CLIP_REQUEST | CLIP_NOTIFY | CLIP_PROVIDE | formats,
                                       *sizes)
                    self.queue(b"\x03\0\0\0" + struct.pack(">i", -len(body)) + body)
            elif kind == 3:
                incremental, x, y, w, h = struct.unpack(">BHHHH", self.recv_exact(9))
                self.log.write(self.id, "fbur", incremental=bool(incremental), rect=[x, y, w, h])
                with self.cond:
                    self.pending_request = (bool(incremental), x, y, w, h)
                    self.cond.notify_all()
            elif kind == 4:
                down, _, keysym = struct.unpack(">BHI", self.recv_exact(7))
                self.log.write(self.id, "key", down=bool(down), keysym=keysym, keysym_hex=f"0x{keysym:x}")
            elif kind == 5:
                mask, x, y = struct.unpack(">BHH", self.recv_exact(5))
                self.log.write(self.id, "pointer", mask=mask, x=x, y=y)
            elif kind == 6:
                length = struct.unpack(">3xi", self.recv_exact(7))[0]
                if length >= 0:
                    text = self.recv_exact(length)
                    self.log.write(self.id, "cut_text", length=length, text=text.decode("utf-8", "replace"))
                else:
                    self.handle_ext_clipboard(self.recv_exact(-length))
            else:
                raise ConnectionError(f"unknown client message {kind}")

    def handle_ext_clipboard(self, body: bytes) -> None:
        flags = struct.unpack(">I", body[:4])[0]
        action = flags & 0xFF000000
        if action & CLIP_CAPS:
            self.log.write(self.id, "ext_clipboard", action="caps", flags=f"0x{flags:08x}")
        elif action == CLIP_NOTIFY:
            self.log.write(self.id, "ext_clipboard", action="notify", formats=flags & 0xFFFF)
            wanted = flags & self.server.clip_formats
            if wanted:
                request = struct.pack(">I", CLIP_REQUEST | wanted)
                self.queue(b"\x03\0\0\0" + struct.pack(">i", -len(request)) + request)
        elif action == CLIP_PROVIDE:
            # One u32 size + data per format bit, in bit order (text, rtf, html).
            data = zlib.decompress(body[4:])
            values, offset = {}, 0
            for bit, name in ((CLIP_TEXT, "text"), (CLIP_RTF, "rtf"), (CLIP_HTML, "html")):
                if flags & bit and offset + 4 <= len(data):
                    size = struct.unpack(">I", data[offset:offset + 4])[0]
                    values[name] = data[offset + 4:offset + 4 + size].rstrip(b"\0").decode("utf-8", "replace")
                    offset += 4 + size
            self.log.write(self.id, "ext_clipboard", action="provide", formats=flags & 0xFFFF,
                           text=values.get("text"), html=values.get("html"), rtf=values.get("rtf"))
        elif action == CLIP_REQUEST:
            text = getattr(self, "server_clipboard", "")
            payload = text.replace("\n", "\r\n").encode() + b"\0"
            packed = zlib.compress(struct.pack(">I", len(payload)) + payload)
            provide = struct.pack(">I", CLIP_PROVIDE | CLIP_TEXT) + packed
            self.queue(b"\x03\0\0\0" + struct.pack(">i", -len(provide)) + provide)
            self.log.write(self.id, "ext_clipboard", action="request", formats=flags & 0xFFFF)
        else:
            self.log.write(self.id, "ext_clipboard", action=f"0x{action:08x}")

    # ── writer ─────────────────────────────────────────────────────────
    def write_loop(self) -> None:
        while not self.closed:
            with self.cond:
                while not self.closed and not self.outbox and not self._update_ready():
                    self.cond.wait(0.25)
                if self.closed:
                    return
                if self.server.frozen.is_set():
                    self.cond.wait(0.25)
                    continue
                outbox, self.outbox = self.outbox, []
                message = None
                if self._update_ready():
                    message = self._build_update()
            for item in outbox:
                self.send(item)
            if message:
                self.send(message)
                self.updates_sent += 1

    def _update_ready(self) -> bool:
        if self.pending_request is None or self.server.frozen.is_set():
            return False
        return not self.pending_request[0] or bool(self.dirty) or self.pending_resize is not None

    def _build_update(self) -> bytes:
        incremental, rx, ry, rw, rh = self.pending_request
        self.pending_request = None
        scene = self.server.scene
        rects: list[bytes] = []
        if self.pending_resize is not None:
            width, height = self.pending_resize
            self.pending_resize = None
            if ENC_DESKTOP_SIZE in self.encodings:
                rects.append(struct.pack(">HHHHi", 0, 0, width, height, ENC_DESKTOP_SIZE))
                # The next request repaints the whole new surface.
                self.dirty = [(0, 0, width, height)]
                self.log.write(self.id, "desktop_size", width=width, height=height)
                return b"\0\0" + struct.pack(">H", len(rects)) + b"".join(rects)
        if not incremental:
            areas = [(rx, ry, rw, rh)]
        else:
            areas = self.dirty
        self.dirty = []
        with scene.lock:
            fb = scene.fb
            for x, y, w, h in areas:
                x2, y2 = min(scene.width, x + w), min(scene.height, y + h)
                if x2 <= x or y2 <= y:
                    continue
                rects.extend(self._encode_area(fb, x, y, x2 - x, y2 - y))
        return b"\0\0" + struct.pack(">H", len(rects)) + b"".join(rects)

    def _encode_area(self, fb: np.ndarray, x: int, y: int, w: int, h: int) -> list[bytes]:
        use_tight = not self.server.args.no_tight and ENC_TIGHT in self.encodings and (
            ENC_RAW not in self.encodings or self.encodings.index(ENC_TIGHT) < self.encodings.index(ENC_RAW))
        out = []
        if not use_tight:
            out.append(struct.pack(">HHHHi", x, y, w, h, ENC_RAW) + self.pf.pack(fb[y:y + h, x:x + w]))
            return out
        for by in range(y, y + h, TIGHT_BAND_ROWS):
            bh = min(TIGHT_BAND_ROWS, y + h - by)
            for bx in range(x, x + w, TIGHT_MAX_WIDTH):
                bw = min(TIGHT_MAX_WIDTH, x + w - bx)
                block = np.ascontiguousarray(fb[by:by + bh, bx:bx + bw])
                out.append(struct.pack(">HHHHi", bx, by, bw, bh, ENC_TIGHT) + self.tight.encode(self.pf, block))
        return out

    def serve(self) -> None:
        self.log.write(self.id, "connect", peer=f"{self.sock.getpeername()[0]}")
        writer = None
        try:
            if not self.handshake():
                return
            with self.server.scene.lock:
                self.server.scene.clients.append(self)
            writer = threading.Thread(target=self.write_loop, daemon=True)
            writer.start()
            self.read_loop()
        except (ConnectionError, OSError) as error:
            self.log.write(self.id, "disconnect", reason=str(error))
        finally:
            with self.cond:
                self.closed = True
                self.cond.notify_all()
            with self.server.scene.lock:
                if self in self.server.scene.clients:
                    self.server.scene.clients.remove(self)
            try:
                self.sock.close()
            except OSError:
                pass


def control_loop(server: Server, port: int) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", port))
    listener.listen(4)
    while True:
        conn, _ = listener.accept()
        with conn:
            data = b""
            conn.settimeout(2)
            try:
                # Until the sender half-closes (or 2 s pass), so several
                # commands can share one connection.
                while chunk := conn.recv(65536):
                    data += chunk
            except socket.timeout:
                pass
            replies = [handle_command(server, line.strip()) for line in data.decode("utf-8").splitlines() if line.strip()]
            conn.sendall(("\n".join(replies) + "\n").encode())


def watch_commands(server: Server) -> None:
    """Run the lines of the watched file as control commands whenever its
    content changes (test runners that can only write files drive the fixture
    so). `watch PATH` retargets this single watcher."""
    path, seen = None, None
    while True:
        if server.watch_path != path:
            path, seen = server.watch_path, None
        try:
            with open(path, encoding="utf-8") as handle:
                content = handle.read()
        except OSError:
            content = None
        if content is not None and content != seen:
            for line in content.splitlines():
                if line.strip() and not line.startswith("#"):
                    handle_command(server, line.strip())
            seen = content
        time.sleep(0.1)


def drop_clients(clients: list["Client"]) -> None:
    for client in clients:
        try:
            client.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        client.sock.close()


def handle_command(server: Server, line: str) -> str:
    verb, _, rest = line.partition(" ")
    clients = list(server.scene.clients)
    server.log.write(0, "control", command=verb, arg=rest[:64])
    if verb == "log":
        server.log.tee(rest.strip())
    elif verb == "watch":
        first = server.watch_path is None
        server.watch_path = rest.strip()
        if first:
            threading.Thread(target=watch_commands, args=(server,), daemon=True).start()
    elif verb == "reset":
        # A fresh fixture for the next test case: no clients, default state.
        drop_clients(clients)
        server.frozen.clear()
        server.reject_auth = server.args.reject_auth
        server.auth_delay_ms = server.args.auth_delay_ms
        server.scene.resize(server.args.width, server.args.height, notify=False)
    elif verb == "resize":
        width, height = (int(v) for v in rest.split())
        server.scene.resize(width, height)
    elif verb == "cuttext":
        payload = rest.encode("latin-1", "replace")
        for client in clients:
            client.queue(b"\x03\0\0\0" + struct.pack(">I", len(payload)) + payload)
    elif verb == "extclip":
        for client in clients:
            client.server_clipboard = rest
            notify = struct.pack(">I", CLIP_NOTIFY | CLIP_TEXT)
            client.queue(b"\x03\0\0\0" + struct.pack(">i", -len(notify)) + notify)
    elif verb == "bell":
        for client in clients:
            client.queue(b"\x02")
    elif verb == "drop":
        drop_clients(clients)
    elif verb == "freeze":
        server.frozen.set()
    elif verb == "thaw":
        server.frozen.clear()
        for client in clients:
            with client.cond:
                client.cond.notify_all()
    elif verb == "reject-auth":
        server.reject_auth = rest.strip() == "on"
    elif verb == "auth-delay":
        server.auth_delay_ms = int(rest.strip() or 0)
    elif verb == "stats":
        return json.dumps([{"conn": c.id, "bytes_sent": c.bytes_sent, "updates": c.updates_sent,
                            "encodings": c.encodings, "pixel_format": c.pf.describe()} for c in clients])
    else:
        return f"unknown command {verb}"
    return "ok"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=5988)
    parser.add_argument("--control-port", type=int, default=0)
    parser.add_argument("--log")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--version", type=int, choices=[3, 7, 8], default=8)
    parser.add_argument("--security", choices=["none", "vncauth"], default="vncauth")
    parser.add_argument("--password-env", help="environment variable holding the VNCAuth password")
    parser.add_argument("--auth-delay-ms", type=int, default=0)
    parser.add_argument("--reject-auth", action="store_true")
    parser.add_argument("--animate-fps", type=float, default=0.0)
    parser.add_argument("--ext-clipboard", action="store_true")
    parser.add_argument("--clip-formats", default="text",
                        help="ExtendedClipboard formats the fixture accepts: text,rtf,html")
    parser.add_argument("--no-tight", action="store_true", help="behave like a server without Tight")
    parser.add_argument("--name", default="taomni-vnc-fixture")
    args = parser.parse_args()
    server = Server(args)
    if args.control_port:
        threading.Thread(target=control_loop, args=(server, args.control_port), daemon=True).start()
    if args.animate_fps > 0:
        def animate() -> None:
            while True:
                time.sleep(1.0 / args.animate_fps)
                server.scene.animate()
        threading.Thread(target=animate, daemon=True).start()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", args.port))
    listener.listen(8)
    print(json.dumps({"listening": args.port, "control": args.control_port}), flush=True)
    while True:
        sock, _ = listener.accept()
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        threading.Thread(target=Client(server, sock).serve, daemon=True).start()


if __name__ == "__main__":
    main()
