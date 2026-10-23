import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from ci_clickhouse import download, server_config
from qa_ui_auto.fixtures import clickhouse_required


class ClickHouseFixtureTests(unittest.TestCase):
    def test_config_has_private_ports_and_only_password_hash(self):
        secret = "disposable<&password"
        xml = server_config("/tmp/qa&test", 19000, 18123, secret)
        root = ET.fromstring(xml)
        self.assertNotIn(secret, xml)
        self.assertEqual(root.findtext("users/qa/password_sha256_hex"), hashlib.sha256(secret.encode()).hexdigest())
        self.assertEqual(root.findtext("listen_host"), "127.0.0.1")
        self.assertEqual(root.findtext("tcp_port"), "19000")
        self.assertEqual(root.findtext("http_port"), "18123")
        self.assertEqual(root.findtext("path"), "/tmp/qa&test/data/")

    def test_bad_download_never_replaces_installed_package(self):
        import io
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "package"
            target.write_bytes(b"previous")
            with patch("urllib.request.urlopen", return_value=io.BytesIO(b"corrupt")):
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    download("https://example.invalid/package", target, hashlib.sha256(b"expected").hexdigest())
            self.assertEqual(target.read_bytes(), b"previous")
            self.assertFalse(target.with_suffix(".part").exists())

    def test_verified_cached_package_does_not_download(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "package"
            target.write_bytes(b"verified")
            with patch("urllib.request.urlopen") as network:
                download("https://example.invalid/package", target, hashlib.sha256(b"verified").hexdigest())
            network.assert_not_called()

    def test_missing_fixture_is_failure_not_skip(self):
        import sys
        from types import SimpleNamespace
        with patch.dict(sys.modules, {"clickhouse_driver": SimpleNamespace(Client=object)}), patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "requires"):
                clickhouse_required.setup(SimpleNamespace(cfg={}, env={}))


if __name__ == "__main__":
    unittest.main()
