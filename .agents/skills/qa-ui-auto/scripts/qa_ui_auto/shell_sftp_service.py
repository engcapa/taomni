"""Real loopback SSH/SFTP endpoint, bounded throughput, report-owned host files.

The real Tauri SSH client sends protocol requests. Byte receipts and file hashes
are read by this separate service; no app IPC or progress events are replaced.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import secrets
import socket
import threading
import time
import paramiko


class RateHandle(paramiko.SFTPHandle):
    def __init__(self, endpoint, path, flags):
        super().__init__(flags)
        self.endpoint, self.path = endpoint, path

    def observe(self, action, offset, size):
        if self.endpoint.stop_event.wait(size / self.endpoint.bytes_per_sec):
            raise OSError("QA SFTP endpoint stopped")
        row = dict(action=action, path=self.path.relative_to(self.endpoint.remote).as_posix(), offset=offset, bytes=size, monotonic=time.monotonic())
        with self.endpoint.lock, (self.endpoint.root / "sftp-service-bytes.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row) + "\n")

    def read(self, offset, length):
        result = super().read(offset, length)
        if isinstance(result, bytes):
            self.observe("read", offset, len(result))
        return result

    def write(self, offset, data):
        self.observe("write", offset, len(data))
        return super().write(offset, data)

    def stat(self):
        try:
            stream = getattr(self, "readfile", None) or self.writefile
            return paramiko.SFTPAttributes.from_stat(os.fstat(stream.fileno()))
        except OSError as err:
            return paramiko.SFTPServer.convert_errno(err.errno)

    def chattr(self, attr):
        try:
            paramiko.SFTPServer.set_file_attr(str(self.path), attr)
            return paramiko.SFTP_OK
        except OSError as err:
            return paramiko.SFTPServer.convert_errno(err.errno)


class SftpFiles(paramiko.SFTPServerInterface):
    def __init__(self, interface, *args, endpoint, **kwargs):
        super().__init__(interface, *args, **kwargs)
        self.endpoint = endpoint

    def path(self, raw):
        path = (self.endpoint.remote / str(raw).lstrip("/")).resolve()
        if not path.is_relative_to(self.endpoint.remote):
            raise PermissionError(13, "Path is outside this QA endpoint")
        return path

    def canonicalize(self, path):
        relative = self.path(path).relative_to(self.endpoint.remote).as_posix()
        return "/" if relative == "." else "/" + relative

    def list_folder(self, path):
        try:
            entries = []
            for child in self.path(path).iterdir():
                attrs = paramiko.SFTPAttributes.from_stat(child.stat())
                attrs.filename = child.name
                entries.append(attrs)
            return entries
        except OSError as err:
            return paramiko.SFTPServer.convert_errno(err.errno)

    def stat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(self.path(path).stat())
        except OSError as err:
            return paramiko.SFTPServer.convert_errno(err.errno)

    lstat = stat

    def open(self, path, flags, attr):
        try:
            target = self.path(path)
            fd = os.open(target, flags, 0o600)
            mode = "r+b" if flags & os.O_RDWR else "wb" if flags & os.O_WRONLY else "rb"
            stream = os.fdopen(fd, mode)
            handle = RateHandle(self.endpoint, target, flags)
            if flags & (os.O_RDWR | os.O_WRONLY):
                handle.writefile = stream
            if not flags & os.O_WRONLY:
                handle.readfile = stream
            return handle
        except OSError as err:
            return paramiko.SFTPServer.convert_errno(err.errno)

    def mkdir(self, path, attr):
        try:
            self.path(path).mkdir()
            return paramiko.SFTP_OK
        except OSError as err:
            return paramiko.SFTPServer.convert_errno(err.errno)

    def remove(self, path):
        try:
            self.path(path).unlink()
            return paramiko.SFTP_OK
        except OSError as err:
            return paramiko.SFTPServer.convert_errno(err.errno)

    def rename(self, old, new):
        try:
            self.path(old).rename(self.path(new))
            return paramiko.SFTP_OK
        except OSError as err:
            return paramiko.SFTPServer.convert_errno(err.errno)

    def rmdir(self, path):
        try:
            self.path(path).rmdir()
            return paramiko.SFTP_OK
        except OSError as err:
            return paramiko.SFTPServer.convert_errno(err.errno)

    def chattr(self, path, attr):
        try:
            paramiko.SFTPServer.set_file_attr(str(self.path(path)), attr)
            return paramiko.SFTP_OK
        except OSError as err:
            return paramiko.SFTPServer.convert_errno(err.errno)


class Login(paramiko.ServerInterface):
    def __init__(self, endpoint):
        self.endpoint = endpoint

    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if username == "qa" and secrets.compare_digest(password, self.endpoint.password) else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED


class ShellSftpServer:
    def __init__(self, root, bytes_per_sec=256 * 1024):
        self.root = Path(root).resolve()
        self.remote = self.root / "remote"
        self.remote.mkdir(parents=True, exist_ok=True)
        self.password = secrets.token_hex(16)
        self.bytes_per_sec = bytes_per_sec
        self.key = paramiko.RSAKey.generate(2048)
        self.stop_event = threading.Event()
        self.transports, self.threads = [], []
        self.lock = threading.Lock()
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(8)
        self.listener.settimeout(.2)
        self.port = self.listener.getsockname()[1]
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    def accept(self):
        while not self.stop_event.is_set():
            try:
                sock, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            thread = threading.Thread(target=self.serve, args=(sock,), daemon=True)
            self.threads.append(thread)
            thread.start()

    def serve(self, sock):
        transport = paramiko.Transport(sock)
        self.transports.append(transport)
        try:
            transport.add_server_key(self.key)
            transport.set_subsystem_handler("sftp", paramiko.SFTPServer, SftpFiles, endpoint=self)
            transport.start_server(server=Login(self))
            while transport.is_active() and not self.stop_event.wait(.1):
                pass
        finally:
            transport.close()

    def stop(self):
        self.stop_event.set()
        self.listener.close()
        for transport in self.transports:
            transport.close()
        self.thread.join(timeout=3)
        for thread in self.threads:
            thread.join(timeout=3)
