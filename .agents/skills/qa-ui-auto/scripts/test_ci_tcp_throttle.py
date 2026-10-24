"""Real loopback bytes, transfer pacing and cancellation of owned links."""
import socket
import threading
import time
import unittest

from ci_tcp_throttle import ThrottledTcpLink


class ThrottledTcpLinkTest(unittest.TestCase):
    def test_bidirectional_bytes_are_exact_and_the_response_is_rate_limited(self):
        payload = bytes(range(256)) * 128
        request = b"a real SSH stream may carry arbitrary binary bytes\0\xff"
        received = []
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()

            def serve():
                with listener.accept()[0] as peer:
                    peer.settimeout(3)
                    data = b""
                    while len(data) < len(request):
                        data += peer.recv(4096)
                    received.append(data)
                    peer.sendall(payload)

            server = threading.Thread(target=serve)
            server.start()
            with ThrottledTcpLink(listener.getsockname()[1], bytes_per_second=65_536) as link:
                with socket.create_connection(("127.0.0.1", link.port), timeout=3) as client:
                    started = time.monotonic()
                    client.sendall(request)
                    client.shutdown(socket.SHUT_WR)
                    output = bytearray()
                    while block := client.recv(8192):
                        output.extend(block)
                    elapsed = time.monotonic() - started
            server.join(timeout=3)
        self.assertEqual(received, [request])
        self.assertEqual(output, payload)
        self.assertGreaterEqual(elapsed, .48)
        self.assertFalse(server.is_alive())
        self.assertFalse(link.thread.is_alive())

    def test_close_interrupts_a_pending_rate_wait_and_releases_the_listener(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            link = ThrottledTcpLink(listener.getsockname()[1], bytes_per_second=1)
            with socket.create_connection(("127.0.0.1", link.port), timeout=3) as client, \
                    listener.accept()[0] as upstream:
                upstream.sendall(b"must not wait this many seconds during cleanup")
                started = time.monotonic()
                link.close()
                self.assertLess(time.monotonic() - started, 2)
                self.assertEqual(client.recv(1), b"")
            self.assertFalse(link.thread.is_alive())
            with self.assertRaises(OSError):
                socket.create_connection(("127.0.0.1", link.port), timeout=.2)


if __name__ == "__main__":
    unittest.main()
