"""Identify the real RPM and AppImage application on the hosted Linux runner."""
from pathlib import Path
import shutil

from modular_bundle_inventory import digest
from qa_ui_auto.legacy_install import command


def install_rpm(package: Path, version: str, evidence: Path) -> Path:
    expected = f"taomni {version} x86_64"
    fields = "%{NAME} %{VERSION} %{ARCH}"
    package_metadata = command(["rpm", "-qp", "--qf", fields, str(package)],
                               evidence, "rpm-metadata").stdout.decode()
    if package_metadata != expected:
        raise RuntimeError("Unexpected release RPM identity")
    # Ubuntu supplies the runtime dependencies installed with the verified deb.
    command(["sudo", "dpkg", "--remove", "taomni"], evidence, "deb-remove")
    # The package database on Ubuntu follows the user who runs RPM.
    manager = ["sudo", "rpm"]
    command([*manager, "--install", "--nodeps", str(package)], evidence, "rpm-install")
    registered = command([*manager, "-q", "--qf", fields, "taomni"], evidence, "rpm-installed").stdout.decode()
    binary = Path("/usr/bin/taomni")
    owner = command([*manager, "-qf", "--qf", fields, str(binary)], evidence, "rpm-executable-owner").stdout.decode()
    if registered != expected or owner != expected or not binary.is_file():
        raise RuntimeError("The RPM did not install and register the release executable")
    return binary


def prepare_appimage(package: Path, work: Path) -> Path:
    work.mkdir()
    launcher = work / package.name
    shutil.copyfile(package, launcher)
    launcher.chmod(0o700)
    if digest(launcher) != digest(package):
        raise RuntimeError("The copied AppImage differs from the release artifact")
    return launcher


def appimage_binary(launcher: Path, process_group: int, proc: Path = Path("/proc")) -> Path:
    image_entry = b"APPIMAGE=" + str(launcher).encode()
    matches = []
    for process in proc.iterdir():
        if not process.name.isdecimal():
            continue
        try:
            state, _, group, *_ = (process / "stat").read_text().rsplit(")", 1)[1].split()
            if state == "Z" or int(group) != process_group:
                continue
            executable = (process / "exe").resolve(strict=True)
            if executable.name != "taomni":
                continue
            environment = (process / "environ").read_bytes().split(b"\0")
        except (OSError, ValueError, IndexError):
            continue
        appdir = next((Path(item[7:].decode()) for item in environment if item.startswith(b"APPDIR=")), None)
        if image_entry in environment and appdir and executable.is_relative_to(appdir):
            matches.append(executable)
    if len(matches) != 1:
        raise RuntimeError("Expected one Taomni process launched by the matching AppImage")
    return matches[0]
