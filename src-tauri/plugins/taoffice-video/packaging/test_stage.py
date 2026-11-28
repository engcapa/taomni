from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import stage


CODEC = "libavcodec.63.dylib"
FULL_CODEC = "libavcodec.63.24.100.dylib"
FORMAT = "libavformat.63.dylib"
FULL_FORMAT = "libavformat.63.16.100.dylib"


def mach_o_lines(binary, *names):
    return f"{binary}:\n" + "".join(
        f"\t{name} (compatibility version 63.0.0, current version 63.24.100)\n"
        for name in names
    )


class MediaSourceNoticeTests(unittest.TestCase):
    def test_windows_candidate_and_unix_signer_check_out_identical_notice_bytes(self):
        repo = stage.SOURCE.parents[4]
        source = stage.SOURCE.relative_to(repo).as_posix()
        blob = subprocess.check_output(["git", "show", f":{source}"], cwd=repo)
        for autocrlf in ("true", "false"):
            with self.subTest(autocrlf=autocrlf):
                checkout = subprocess.check_output([
                    "git", "-c", f"core.autocrlf={autocrlf}", "cat-file",
                    "--filters", f"--path={source}", f":{source}",
                ], cwd=repo)
                self.assertEqual(checkout, blob)


class MacosMediaStagingTests(unittest.TestCase):
    def test_uses_actual_symlink_and_install_id_aliases(self):
        with TemporaryDirectory() as root:
            lib = Path(root) / "lib"
            lib.mkdir()
            (lib / FULL_CODEC).write_bytes(b"codec")
            (lib / CODEC).symlink_to(FULL_CODEC)
            (lib / FORMAT).write_bytes(b"format")

            def install_id(command, flag, source):
                self.assertEqual((command, flag), ("otool", "-D"))
                name = FULL_CODEC if source.name == FULL_CODEC else FULL_FORMAT
                return f"{source}:\n@rpath/{name}\n"

            with patch.object(stage, "output", side_effect=install_id):
                aliases, ids = stage.macos_library_names(lib, {CODEC, FORMAT})
            self.assertEqual(aliases, {
                CODEC: CODEC, FULL_CODEC: CODEC,
                FORMAT: FORMAT, FULL_FORMAT: FORMAT,
            })
            self.assertEqual(ids, {CODEC: f"@rpath/{FULL_CODEC}", FORMAT: f"@rpath/{FULL_FORMAT}"})

    def test_rewrites_host_and_library_references_and_the_library_id(self):
        host = Path(stage.HOST)
        library = Path(FORMAT)
        aliases = {CODEC: CODEC, FULL_CODEC: CODEC, FORMAT: FORMAT, FULL_FORMAT: FORMAT}
        install_id = f"@rpath/{FULL_FORMAT}"
        system = "/usr/lib/libSystem.B.dylib"
        paths = "cmd LC_RPATH\n  cmdsize 32\n  path @loader_path (offset 12)\n"

        def commands_for(command, flag, binary):
            if command == "lipo":
                return "arm64\n"
            if flag == "-l":
                return paths
            if binary == host:
                return mach_o_lines(binary, f"@rpath/{FULL_CODEC}", system)
            return mach_o_lines(binary, install_id, f"@rpath/{FULL_CODEC}", system)

        with patch.object(stage, "output", side_effect=commands_for), patch.object(stage, "run") as run:
            stage.relocate_macos(host, aliases, "arm64")
            run.assert_called_once_with(
                "install_name_tool", "-change", f"@rpath/{FULL_CODEC}", f"@loader_path/{CODEC}",
                "-delete_rpath", "@loader_path", host,
            )
            run.reset_mock()
            stage.relocate_macos(library, aliases, "arm64", install_id)
            run.assert_called_once_with(
                "install_name_tool", "-change", f"@rpath/{FULL_CODEC}", f"@loader_path/{CODEC}",
                "-id", f"@loader_path/{FORMAT}", "-delete_rpath", "@loader_path", library,
            )

    def test_rejects_an_unstaged_version_and_an_incorrect_architecture(self):
        host = Path(stage.HOST)
        aliases = {CODEC: CODEC, FULL_CODEC: CODEC}
        unknown = mach_o_lines(host, "@rpath/libavcodec.63.24.101.dylib")
        with patch.object(stage, "output", side_effect=["arm64\n", unknown]), patch.object(stage, "run") as run:
            with self.assertRaisesRegex(ValueError, "unstaged library"):
                stage.relocate_macos(host, aliases, "arm64")
            run.assert_not_called()
        with patch.object(stage, "output", return_value="x86_64\n"), patch.object(stage, "run") as run:
            with self.assertRaisesRegex(ValueError, "target architecture"):
                stage.relocate_macos(host, aliases, "arm64")
            run.assert_not_called()

    def test_rejects_a_library_symlink_outside_the_install_library_directory(self):
        with TemporaryDirectory() as root:
            lib = Path(root) / "lib"
            lib.mkdir()
            outside = Path(root) / FULL_CODEC
            outside.write_bytes(b"outside")
            (lib / CODEC).symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "outside the pinned Media library directory"):
                stage.macos_library_names(lib, {CODEC})


if __name__ == "__main__":
    unittest.main()
