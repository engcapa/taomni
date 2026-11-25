import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from check_linux_module_abi import glibc_requirements, inspect_payload, supports


class LinuxModuleAbiTests(unittest.TestCase):
    def test_only_required_versions_affect_the_ubuntu_2204_floor(self):
        versions = """Version definition section '.gnu.version_d' contains 2 entries:
  000000: Rev: 1  Flags: none  Index: 2  Cnt: 1  Name: GLIBC_2.40
Version needs section '.gnu.version_r' contains 1 entry:
  000000: Version: 1  File: libc.so.6  Cnt: 4
  0x0010:   Name: GLIBC_2.2.5  Flags: none  Version: 3
  0x0020:   Name: GLIBC_2.35  Flags: none  Version: 2
  0x0030:   Name: GLIBC_2.39  Flags: none  Version: 5
  0x0040:   Name: GLIBC_ABI_DT_RELR  Flags: none  Version: 4
"""
        required = glibc_requirements(versions)
        self.assertEqual(required, ["GLIBC_2.2.5", "GLIBC_2.35", "GLIBC_2.39", "GLIBC_ABI_DT_RELR"])
        self.assertEqual([item for item in required if supports(item)], ["GLIBC_2.2.5", "GLIBC_2.35"])

    def test_payload_checks_bundled_libraries_and_records_the_inspected_bytes(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "module.json"
            manifest.write_text(json.dumps({"entry": {"host": "host"}, "id": "test", "version": "1"}))
            data = b"\x7fELF\x02\x01" + bytes(12) + b"\x3e\x00"
            (root / "host").write_bytes(data)
            (root / "libraries").mkdir()
            (root / "libraries/libvoice.so.1").write_bytes(data + b"library")
            (root / "index.js").write_text("export {}")
            with patch("check_linux_module_abi.subprocess.run") as readelf:
                readelf.return_value.stdout = "Version needs section '.gnu.version_r':\n Name: GLIBC_2.39 Flags: none"
                result = inspect_payload(manifest)
            self.assertEqual(len(result["binaries"]), 2)
            self.assertEqual(result["binaries"][0]["sha256"], hashlib.sha256(data).hexdigest())
            self.assertIn("libraries/libvoice.so.1 requires GLIBC_2.39", result["errors"])
            self.assertIn("host requires GLIBC_2.39", result["errors"])
            (root / "host").write_text("not a Linux executable")
            (root / "libraries/libvoice.so.1").unlink()
            self.assertIn("host is not an ELF binary", inspect_payload(manifest)["errors"])
