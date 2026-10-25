"""An owned loopback link for observable real SSH transfer lifecycle tests."""
from __future__ import annotations

from contextlib import suppress
import socket
import socketserver
import threading
import time


class ThrottledTcpLink:
    """Limit server-to-client bytes, including the Python SCP resume source."""

    def __init__(self, upstream_port: int, *, bytes_per_second: int = 262_144):
        if bytes_per_second <= 0:
            raise ValueError("bytes_per_second must be positive")
        self.upstream_port = upstream_port
        self.bytes_per_second = bytes_per_second
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.sockets: set[socket.socket] = set()
        owner = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                owner._connection(self.request)

        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": .05}, daemon=True)
        self.thread.start()

    def _connection(self, client: socket.socket) -> None:
        with self.lock:
            if self.stopped.is_set():
                return
            self.sockets.add(client)
        upstream = None
        try:
            upstream = socket.create_connection(("127.0.0.1", self.upstream_port), timeout=2)
            with self.lock:
                if self.stopped.is_set():
                    return
                self.sockets.add(upstream)
            client.settimeout(.2)
            upstream.settimeout(.2)
            downstream = threading.Thread(target=self._pump,
                args=(upstream, client, self.bytes_per_second), daemon=True)
            downstream.start()
            self._pump(client, upstream, 0)
            downstream.join()
        except OSError:
            # Cancellation closes its real SSH stream; the app owns its result.
            pass
        finally:
            for connection in (client, upstream):
                if connection is not None:
                    with self.lock:
                        self.sockets.discard(connection)
                    connection.close()

    def _pump(self, source: socket.socket, destination: socket.socket, rate: int) -> None:
        deadline = time.monotonic()
        try:
            while not self.stopped.is_set():
                try:
                    block = source.recv(16_384)
                except socket.timeout:
                    continue
                if not block:
                    break
                if rate:
                    # Idle time earns no burst credit; a resumed stream must
                    # remain observable and cancellable through the real UI.
                    deadline = max(deadline, time.monotonic()) + len(block) / rate
                    if self.stopped.wait(max(0, deadline - time.monotonic())):
                        break
                destination.sendall(block)
        except OSError:
            pass
        finally:
            with suppress(OSError):
                destination.shutdown(socket.SHUT_WR)

    def close(self) -> None:
        self.stopped.set()
        with self.lock:
            for connection in self.sockets:
                with suppress(OSError):
                    connection.shutdown(socket.SHUT_RDWR)
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()

    def __enter__(self) -> ThrottledTcpLink:
        return self

    def __exit__(self, *_args) -> None:
        self.close()
