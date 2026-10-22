"""Exercise acquisition recovery, integrity and publication of the QA compiler."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import urlopen
import zipfile

import ci_setup_protoc as setup


@unittest.skipUnless(os.name == "posix", "executable fixture uses a POSIX shell")
class ProtocSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.contents = self.archive("23.4")
        self.expected = hashlib.sha256(self.contents).hexdigest()

    @staticmethod
    def archive(version):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zipped:
            zipped.writestr("bin/protoc", f"#!/bin/sh\nprintf 'libprotoc {version}\\n'\n")
            zipped.writestr("include/google/protobuf/empty.proto", 'syntax = "proto3";')
        return buffer.getvalue()

    def install_from(self, contents, expected=None):
        def download(_url, destination):
            destination.write_bytes(contents)
        with patch.object(setup, "ARCHIVES", {("Linux", "x86_64"): ("linux-x86_64", expected or self.expected)}), \
             patch.object(setup, "download", side_effect=download):
            return setup.install(self.root, "Linux", "x86_64")

    def test_transient_download_retries_the_fixed_asset_then_publishes_a_verified_compiler(self):
        requests = []
        contents = self.contents
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(503 if len(requests) == 1 else 200)
                self.end_headers()
                if len(requests) > 1:
                    self.wfile.write(contents)
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        urls = []
        def open_asset(url, **kwargs):
            urls.append(url)
            return urlopen(f"http://127.0.0.1:{server.server_port}/protoc.zip", **kwargs)
        with patch.object(setup, "ARCHIVES", {("Linux", "x86_64"): ("linux-x86_64", self.expected)}), \
             patch.object(setup, "urlopen", side_effect=open_asset), patch.object(setup.time, "sleep"):
            installed = setup.install(self.root, "Linux", "x86_64")
        self.assertEqual(urls, ["https://github.com/protocolbuffers/protobuf/releases/download/"
                                "v23.4/protoc-23.4-linux-x86_64.zip"] * 2)
        self.assertEqual(requests, ["/protoc.zip"] * 2)
        self.assertTrue((installed / "protoc").is_file())
        self.assertTrue((installed.parent / "include/google/protobuf/empty.proto").is_file())
        self.assertEqual(list(self.root.iterdir()), [installed.parent])

    def test_bad_checksum_keeps_the_previous_compiler(self):
        installed = self.install_from(self.contents)
        original = (installed / "protoc").read_bytes()
        with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
            self.install_from(b"partial download")
        self.assertEqual((installed / "protoc").read_bytes(), original)
        self.assertEqual(list(self.root.iterdir()), [installed.parent])

    def test_wrong_executable_version_is_never_published(self):
        archive = self.archive("99.0")
        with self.assertRaisesRegex(RuntimeError, "Unexpected protoc version"):
            self.install_from(archive, hashlib.sha256(archive).hexdigest())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_network_failure_is_bounded_and_cleans_partial_downloads(self):
        path = self.root / "partial.zip"
        def interrupted(*_args, **_kwargs):
            path.write_bytes(b"partial")
            raise OSError("connection reset")
        with patch.object(setup, "urlopen", side_effect=interrupted) as opened, \
             patch.object(setup.time, "sleep"):
            with self.assertRaisesRegex(OSError, "connection reset"):
                setup.download("https://example.invalid/protoc.zip", path)
        self.assertEqual(opened.call_count, 3)
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
