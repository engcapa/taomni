"""Disposable in-process IMAP4rev1 + SMTP server for native mail QA.

Only the command subset the Taomni mail backend issues is implemented
(CAPABILITY, LOGIN, LIST, EXAMINE/SELECT incl. ``(CONDSTORE)``, UID SEARCH,
UID FETCH incl. ``CHANGEDSINCE``, UID STORE, UID COPY/MOVE, EXPUNGE,
APPEND, CREATE/DELETE/RENAME, STATUS, IDLE, NOOP, LOGOUT) plus a minimal SMTP
receiver. It binds 127.0.0.1 on ephemeral ports, accepts any credentials and
keeps all state in memory, so it needs no Docker, network or secrets on any of
the three hosted runners. QA verbs mutate the state "as another client" while
the real Tauri app syncs against it.
"""

from __future__ import annotations

import re
import select
import socketserver
import threading
import time
from dataclasses import dataclass, field
from email.utils import format_datetime
from datetime import datetime, timezone


@dataclass
class FakeMessage:
    raw: bytes
    flags: list[str] = field(default_factory=list)
    internal_ts: int = 0
    modseq: int = 1


@dataclass
class FakeFolder:
    uid_validity: int
    uid_next: int = 1
    messages: dict[int, FakeMessage] = field(default_factory=dict)


def build_message(subject: str, sender: str = "QA Sender <qa-sender@example.com>",
                  to: str = "qa@example.com", body: str | None = None,
                  date: datetime | None = None, message_id: str | None = None,
                  ancestry: list[str] | None = None) -> bytes:
    date = date or datetime.now(timezone.utc)
    slug = re.sub(r"[^A-Za-z0-9]+", "-", subject).strip("-") or "message"
    text = body if body is not None else f"Body of {subject}\r\n"
    message_id = message_id or f"{slug}-{time.time_ns()}@qa.taomni"
    thread = ""
    if ancestry:
        refs = " ".join(f"<{item}>" for item in ancestry)
        thread = f"In-Reply-To: <{ancestry[-1]}>\r\nReferences: {refs}\r\n"
    return (
        f"From: {sender}\r\nTo: {to}\r\nSubject: {subject}\r\n"
        f"Date: {format_datetime(date)}\r\nMessage-ID: <{message_id}>\r\n{thread}"
        f"MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{text}"
    ).encode("utf-8")


class FakeMailState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.folders: dict[str, FakeFolder] = {
            "INBOX": FakeFolder(uid_validity=1000),
            "Sent": FakeFolder(uid_validity=1001),
            "Drafts": FakeFolder(uid_validity=1002),
            "Trash": FakeFolder(uid_validity=1003),
            "Archive": FakeFolder(uid_validity=1004),
        }
        self.highest_modseq = 1
        self.log: list[str] = []
        self.smtp_messages: list[dict] = []
        self.idle_waiters: list[threading.Event] = []

    def idle_clients(self) -> int:
        """Connections currently in IDLE (AC-37: zero after the tab closes)."""
        with self.lock:
            return len(self.idle_waiters)

    def bump(self) -> int:
        self.highest_modseq += 1
        for waiter in list(self.idle_waiters):
            waiter.set()
        return self.highest_modseq

    def deliver(self, folder: str, count: int, prefix: str = "QA", thread: bool = False) -> list[int]:
        with self.lock:
            entry = self.folders.setdefault(folder, FakeFolder(uid_validity=2000 + len(self.folders)))
            modseq = self.bump()
            uids = []
            ancestry: list[str] = []
            for index in range(count):
                uid = entry.uid_next
                entry.uid_next += 1
                subject = f"{prefix} {index + 1:04d}"
                message_id = f"{prefix}-{index + 1}-{time.time_ns()}@qa.taomni".replace(" ", "-")
                raw = build_message(subject, message_id=message_id, ancestry=list(ancestry) if thread else None)
                ancestry.append(message_id)
                entry.messages[uid] = FakeMessage(raw=raw, internal_ts=int(time.time()) + index, modseq=modseq)
                uids.append(uid)
            return uids

    def append_raw(self, folder: str, raw: bytes, flags: list[str]) -> int:
        with self.lock:
            entry = self.folders.setdefault(folder, FakeFolder(uid_validity=2000 + len(self.folders)))
            uid = entry.uid_next
            entry.uid_next += 1
            entry.messages[uid] = FakeMessage(raw=raw, flags=list(flags), internal_ts=int(time.time()), modseq=self.bump())
            return uid

    def newest_uids(self, folder: str, count: int) -> list[int]:
        with self.lock:
            return sorted(self.folders[folder].messages)[-count:] if count > 0 else []

    def expunge(self, folder: str, uids: list[int]) -> None:
        with self.lock:
            for uid in uids:
                self.folders[folder].messages.pop(uid, None)
            self.bump()

    def set_flags(self, folder: str, uids: list[int], flags: list[str]) -> None:
        with self.lock:
            modseq = self.bump()
            for uid in uids:
                message = self.folders[folder].messages.get(uid)
                if message:
                    message.flags = list(flags)
                    message.modseq = modseq

    def count(self, folder: str) -> int:
        with self.lock:
            return len(self.folders.get(folder, FakeFolder(0)).messages)


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        return value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return value


def _first_arg(text: str) -> tuple[str, str]:
    text = text.lstrip()
    if text.startswith('"'):
        index, escaped = 1, False
        while index < len(text):
            ch = text[index]
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                return _unquote(text[: index + 1]), text[index + 1:]
            index += 1
        return _unquote(text), ""
    head, _, rest = text.partition(" ")
    return head, rest


def _uid_ranges(spec: str, maximum: int) -> list[tuple[int, int]]:
    ranges = []
    for part in spec.split(","):
        def bound(value: str) -> int:
            return maximum if value == "*" else int(value)
        try:
            if ":" in part:
                a, b = part.split(":", 1)
                lo, hi = bound(a), bound(b)
            else:
                lo = hi = bound(part)
        except ValueError:
            continue
        ranges.append((min(lo, hi), max(lo, hi)))
    return ranges


def _in(uid: int, ranges: list[tuple[int, int]]) -> bool:
    return any(lo <= uid <= hi for lo, hi in ranges)


def _search_tokens(text: str) -> list[str]:
    tokens, index = [], 0
    while index < len(text):
        if text[index].isspace():
            index += 1
        elif text[index] == '"':
            value, rest = _first_arg(text[index:])
            tokens.append(value)
            index = len(text) - len(rest)
        else:
            end = index
            while end < len(text) and not text[end].isspace():
                end += 1
            tokens.append(text[index:end])
            index = end
    return tokens


def _search_keys(folder: FakeFolder, text: str) -> list[int]:
    """AND of TEXT/BODY/SUBJECT/FROM/TO/UNSEEN/SEEN/FLAGGED/KEYWORD/ALL keys."""
    tokens = _search_tokens(text)
    checks = []
    index = 0
    while index < len(tokens):
        key = tokens[index].upper()
        if key == "CHARSET":
            index += 2
            continue
        if key in {"TEXT", "BODY", "SUBJECT", "FROM", "TO", "KEYWORD"} and index + 1 < len(tokens):
            checks.append((key, tokens[index + 1].lower()))
            index += 2
            continue
        checks.append((key, ""))
        index += 1

    def matches(message: FakeMessage) -> bool:
        raw = message.raw.decode("utf-8", "replace")
        head, _, body = raw.partition("\r\n\r\n")
        headers = {}
        for line in head.splitlines():
            name, _, value = line.partition(":")
            headers[name.strip().lower()] = value.strip().lower()
        for key, value in checks:
            if key == "TEXT" and value not in raw.lower():
                return False
            if key == "BODY" and value not in body.lower():
                return False
            if key in {"SUBJECT", "FROM", "TO"} and value not in headers.get(key.lower(), ""):
                return False
            if key == "UNSEEN" and "\\Seen" in message.flags:
                return False
            if key == "SEEN" and "\\Seen" not in message.flags:
                return False
            if key == "FLAGGED" and "\\Flagged" not in message.flags:
                return False
            if key == "KEYWORD" and value not in {flag.lower() for flag in message.flags}:
                return False
        return True

    return [uid for uid, message in sorted(folder.messages.items()) if matches(message)]


def _quote(name: str) -> str:
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _internal_date(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%d-%b-%Y %H:%M:%S +0000")


class _ImapHandler(socketserver.StreamRequestHandler):
    server: "_ImapServer"

    def send(self, data: str | bytes) -> None:
        self.wfile.write(data.encode("utf-8") if isinstance(data, str) else data)
        self.wfile.flush()

    def handle(self) -> None:  # noqa: C901 - protocol switch
        state = self.server.state
        selected: str | None = None
        self.send("* OK Taomni QA fake IMAP ready\r\n")
        while True:
            line = self.rfile.readline()
            if not line:
                return
            command = line.decode("utf-8", "replace").rstrip("\r\n")
            literal = None
            match = re.search(r"\{(\d+)\+?\}$", command)
            if match:
                if not command.endswith("+}"):
                    self.send("+ go ahead\r\n")
                literal = self.rfile.read(int(match.group(1)))
                self.rfile.readline()
                command = command[: match.start()]
            tag, _, rest = command.partition(" ")
            upper = rest.upper()
            with state.lock:
                state.log.append(rest)
            ok = f"{tag} OK done\r\n"
            out: list[bytes] = []
            with state.lock:
                if upper.startswith(("LOGIN", "NOOP", "AUTHENTICATE", "ENABLE", "SUBSCRIBE", "UNSUBSCRIBE")):
                    pass
                elif upper.startswith("LOGOUT"):
                    self.send("* BYE bye\r\n" + ok)
                    return
                elif upper.startswith("CAPABILITY"):
                    out.append(b"* CAPABILITY IMAP4rev1 UIDPLUS MOVE IDLE CONDSTORE SPECIAL-USE\r\n")
                elif upper.startswith(("LIST", "LSUB")):
                    specials = {"Sent": "\\Sent", "Drafts": "\\Drafts", "Trash": "\\Trash", "Archive": "\\Archive"}
                    for name in state.folders:
                        attrs = "\\HasNoChildren" + (f" {specials[name]}" if name in specials else "")
                        out.append(f'* {"LSUB" if upper.startswith("LSUB") else "LIST"} ({attrs}) "/" {_quote(name)}\r\n'.encode())
                elif upper.startswith(("EXAMINE", "SELECT")):
                    name, tail = _first_arg(rest.split(" ", 1)[1] if " " in rest else "")
                    folder = state.folders.get(name)
                    if folder is None:
                        ok = f"{tag} NO no such mailbox\r\n"
                    else:
                        out.append(b"* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft $Junk $NotJunk)\r\n")
                        out.append(f"* {len(folder.messages)} EXISTS\r\n* 0 RECENT\r\n".encode())
                        out.append(f"* OK [UIDVALIDITY {folder.uid_validity}] ok\r\n".encode())
                        out.append(f"* OK [UIDNEXT {folder.uid_next}] ok\r\n".encode())
                        if "CONDSTORE" in tail.upper():
                            out.append(f"* OK [HIGHESTMODSEQ {state.highest_modseq}] ok\r\n".encode())
                        selected = name
                elif upper.startswith(("UID SEARCH", "SEARCH")):
                    folder = state.folders[selected or "INBOX"]
                    maximum = max(folder.messages, default=0)
                    criteria = re.sub(r"^(UID )?SEARCH\s*", "", upper).strip()
                    if criteria == "ALL":
                        hits = sorted(folder.messages)
                    elif criteria == "UNSEEN":
                        hits = [uid for uid, m in sorted(folder.messages.items()) if "\\Seen" not in m.flags]
                    elif criteria.startswith("HEADER MESSAGE-ID "):
                        wanted = _unquote(rest[rest.upper().index("MESSAGE-ID ") + 11:]).strip().lower()
                        hits = [
                            uid for uid, m in sorted(folder.messages.items())
                            if any(
                                line.lower().startswith("message-id:")
                                and line.split(":", 1)[1].strip().lower() == wanted
                                for line in m.raw.decode("utf-8", "replace").splitlines()
                            )
                        ]
                    elif criteria.startswith("UID "):
                        ranges = _uid_ranges(criteria[4:].strip(), maximum)
                        hits = [uid for uid in sorted(folder.messages) if _in(uid, ranges)]
                    else:
                        hits = _search_keys(folder, re.sub(r"^(UID )?SEARCH\s*", "", rest, flags=re.I))
                    out.append(("* SEARCH" + "".join(f" {uid}" for uid in hits) + "\r\n").encode())
                elif upper.startswith("UID FETCH"):
                    folder = state.folders[selected or "INBOX"]
                    args = rest[10:].strip()
                    uid_spec, _, items = args.partition(" ")
                    items_upper = items.upper()
                    since_match = re.search(r"CHANGEDSINCE (\d+)", items_upper)
                    since = int(since_match.group(1)) if since_match else None
                    peek = re.search(r"BODY\.PEEK\[\]<0\.(\d+)>", items_upper)
                    ranges = _uid_ranges(uid_spec, max(folder.messages, default=0))
                    for seq, (uid, message) in enumerate(sorted(folder.messages.items()), start=1):
                        if not _in(uid, ranges) or (since is not None and message.modseq <= since):
                            continue
                        parts = [f"UID {uid}", f"FLAGS ({' '.join(message.flags)})"]
                        if since is not None:
                            parts.append(f"MODSEQ ({message.modseq})")
                        if "RFC822.SIZE" in items_upper:
                            parts.append(f"RFC822.SIZE {len(message.raw)}")
                        if "INTERNALDATE" in items_upper:
                            parts.append(f'INTERNALDATE "{_internal_date(message.internal_ts)}"')
                        chunk = f"* {seq} FETCH ({' '.join(parts)}".encode()
                        if "BODY.PEEK[HEADER]" in items_upper:
                            end = message.raw.find(b"\r\n\r\n")
                            header = message.raw[: end + 4] if end >= 0 else message.raw
                            chunk += f" BODY[HEADER] {{{len(header)}}}\r\n".encode() + header
                        if peek:
                            body = message.raw[: int(peek.group(1))]
                            chunk += f" BODY[]<0> {{{len(body)}}}\r\n".encode() + body
                        elif "BODY.PEEK[]" in items_upper or "RFC822)" in items_upper:
                            chunk += f" BODY[] {{{len(message.raw)}}}\r\n".encode() + message.raw
                        out.append(chunk + b")\r\n")
                elif upper.startswith("UID STORE"):
                    folder = state.folders[selected or "INBOX"]
                    uid_spec, _, spec = rest[10:].strip().partition(" ")
                    flags = re.findall(r"[\\$]?\w+", spec[spec.find("(") + 1: spec.rfind(")")]) if "(" in spec else []
                    modseq = state.bump()
                    for uid in list(folder.messages):
                        if not _in(uid, _uid_ranges(uid_spec, max(folder.messages, default=0))):
                            continue
                        message = folder.messages[uid]
                        if spec.startswith("+"):
                            message.flags += [flag for flag in flags if flag not in message.flags]
                        elif spec.startswith("-"):
                            message.flags = [flag for flag in message.flags if flag not in flags]
                        else:
                            message.flags = flags
                        message.modseq = modseq
                elif upper.startswith(("UID COPY", "UID MOVE")):
                    folder = state.folders[selected or "INBOX"]
                    uid_spec, _, target = rest[9:].strip().partition(" ")
                    target = _unquote(target)
                    dest = state.folders.get(target)
                    ranges = _uid_ranges(uid_spec, max(folder.messages, default=0))
                    moving = [uid for uid in sorted(folder.messages) if _in(uid, ranges)]
                    if dest is None:
                        ok = f"{tag} NO [TRYCREATE] no such mailbox\r\n"
                    else:
                        for uid in moving:
                            message = folder.messages[uid]
                            new_uid = dest.uid_next
                            dest.uid_next += 1
                            dest.messages[new_uid] = FakeMessage(raw=message.raw, flags=list(message.flags), internal_ts=message.internal_ts, modseq=state.bump())
                            if upper.startswith("UID MOVE"):
                                del folder.messages[uid]
                elif upper.startswith(("UID EXPUNGE", "EXPUNGE")):
                    folder = state.folders[selected or "INBOX"]
                    for uid in [uid for uid, m in folder.messages.items() if "\\Deleted" in m.flags]:
                        del folder.messages[uid]
                    state.bump()
                elif upper.startswith("APPEND"):
                    name, tail = _first_arg(rest[6:])
                    flags = re.findall(r"[\\$]?\w+", tail[tail.find("(") + 1: tail.find(")")]) if "(" in tail else []
                    if name not in state.folders:
                        ok = f"{tag} NO [TRYCREATE] no such mailbox\r\n"
                    else:
                        uid = state.append_raw(name, literal or b"", flags)
                        ok = f"{tag} OK [APPENDUID {state.folders[name].uid_validity} {uid}] done\r\n"
                elif upper.startswith("CREATE"):
                    name, _ = _first_arg(rest[6:])
                    state.folders.setdefault(name, FakeFolder(uid_validity=3000 + len(state.folders)))
                elif upper.startswith("DELETE"):
                    name, _ = _first_arg(rest[6:])
                    state.folders.pop(name, None)
                elif upper.startswith("RENAME"):
                    old, tail = _first_arg(rest[6:])
                    new, _ = _first_arg(tail)
                    if old in state.folders:
                        state.folders[new] = state.folders.pop(old)
                elif upper.startswith("STATUS"):
                    name, _ = _first_arg(rest[6:])
                    folder = state.folders.get(name)
                    if folder:
                        unseen = sum(1 for m in folder.messages.values() if "\\Seen" not in m.flags)
                        out.append(f"* STATUS {_quote(name)} (MESSAGES {len(folder.messages)} UNSEEN {unseen} UIDNEXT {folder.uid_next} UIDVALIDITY {folder.uid_validity} HIGHESTMODSEQ {state.highest_modseq})\r\n".encode())
                elif upper.startswith("IDLE"):
                    waiter = threading.Event()
                    state.idle_waiters.append(waiter)
                else:
                    ok = f"{tag} BAD unsupported\r\n"
            if upper.startswith("IDLE"):
                self.send("+ idling\r\n")
                self._idle(waiter, tag)
                continue
            self.send(b"".join(out) + ok.encode())

    def _idle(self, waiter: threading.Event, tag: str) -> None:
        # select() instead of socket timeouts: a timed-out buffered makefile()
        # refuses every later read, so DONE would never be seen.
        state = self.server.state
        line = b""
        try:
            while True:
                if waiter.is_set():
                    waiter.clear()
                    with state.lock:
                        count = len(state.folders["INBOX"].messages)
                    self.send(f"* {count} EXISTS\r\n")
                readable, _, _ = select.select([self.connection], [], [], 0.2)
                if not readable:
                    continue
                line = self.rfile.readline()
                if not line or line.strip().upper() == b"DONE":
                    break
        finally:
            with state.lock:
                if waiter in state.idle_waiters:
                    state.idle_waiters.remove(waiter)
        if line:
            self.send(f"{tag} OK idle done\r\n")



class _SmtpHandler(socketserver.StreamRequestHandler):
    server: "_SmtpServer"

    def handle(self) -> None:
        def send(line: str) -> None:
            self.wfile.write((line + "\r\n").encode())
            self.wfile.flush()

        send("220 qa.taomni ESMTP ready")
        envelope: dict = {"from": None, "to": []}
        while True:
            line = self.rfile.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").strip()
            upper = text.upper()
            if upper.startswith(("EHLO", "HELO")):
                send("250-qa.taomni")
                send("250-SIZE 52428800")
                send("250-8BITMIME")
                send("250 AUTH PLAIN LOGIN")
            elif upper.startswith("AUTH"):
                send("235 2.7.0 Authentication successful")
            elif upper.startswith("MAIL FROM"):
                envelope = {"from": text[10:].strip(" <>"), "to": []}
                send("250 OK")
            elif upper.startswith("RCPT TO"):
                envelope["to"].append(text[8:].strip(" <>"))
                send("250 OK")
            elif upper == "DATA":
                send("354 End data with <CR><LF>.<CR><LF>")
                data = bytearray()
                while True:
                    chunk = self.rfile.readline()
                    if not chunk or chunk in (b".\r\n", b".\n"):
                        break
                    data += chunk[1:] if chunk.startswith(b"..") else chunk
                with self.server.state.lock:
                    self.server.state.smtp_messages.append({**envelope, "raw": bytes(data)})
                send("250 OK queued")
            elif upper in ("RSET", "NOOP"):
                send("250 OK")
            elif upper == "QUIT":
                send("221 bye")
                return
            else:
                send("502 unsupported")


class _ImapServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, state: FakeMailState):
        super().__init__(("127.0.0.1", 0), _ImapHandler)
        self.state = state


class _SmtpServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, state: FakeMailState):
        super().__init__(("127.0.0.1", 0), _SmtpHandler)
        self.state = state


class FakeMailServer:
    def __init__(self) -> None:
        self.state = FakeMailState()
        self._imap = _ImapServer(self.state)
        self._smtp = _SmtpServer(self.state)
        self.imap_port = self._imap.server_address[1]
        self.smtp_port = self._smtp.server_address[1]
        self._threads = [
            threading.Thread(target=self._imap.serve_forever, daemon=True),
            threading.Thread(target=self._smtp.serve_forever, daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    def stop(self) -> None:
        for server in (self._imap, self._smtp):
            server.shutdown()
            server.server_close()


ACTIVE: FakeMailServer | None = None
