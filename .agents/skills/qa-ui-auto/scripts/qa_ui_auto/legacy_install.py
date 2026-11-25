"""Actual deb/MSI/drag-install adapters, restricted to disposable hosted runners."""
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess

from .legacy_release import release_assets, RELEASE_VERSION, selected_asset, verify_asset


def command(args, evidence, label, *, accepted=(0,), timeout=180, env=None):
    try:
        result = subprocess.run(args, capture_output=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired as error:
        (evidence / (label + ".stdout.txt")).write_bytes(error.stdout or b"")
        (evidence / (label + ".stderr.txt")).write_bytes(error.stderr or b"")
        (evidence / (label + ".command.json")).write_text(json.dumps({
            "argv": [str(arg) for arg in args], "exitCode": None, "timeoutSeconds": timeout,
        }, indent=2) + "\n", encoding="utf-8")
        raise
    (evidence / (label + ".stdout.txt")).write_bytes(result.stdout)
    (evidence / (label + ".stderr.txt")).write_bytes(result.stderr)
    (evidence / (label + ".command.json")).write_text(json.dumps({
        "argv": [str(arg) for arg in args], "exitCode": result.returncode,
    }, indent=2) + "\n", encoding="utf-8")
    if result.returncode not in accepted:
        raise RuntimeError(f"Legacy installation {label} exited {result.returncode}; see retained command evidence")
    return result


def linux_install(package, destination, evidence, *, version=RELEASE_VERSION, allow_downgrade=False):
    fields = command(["dpkg-deb", "-f", str(package), "Package", "Version", "Architecture"],
                     evidence, "deb-metadata").stdout.decode()
    # dpkg-deb labels fields when more than one is requested.
    expected = {"Package": "taomni", "Version": version, "Architecture": "amd64"}
    if dict(line.split(": ", 1) for line in fields.strip().splitlines()) != expected:
        raise RuntimeError("Pinned legacy deb metadata is unexpected")
    flags = ["--allow-downgrades"] if allow_downgrade else []
    command(["sudo", "apt-get", "install", "--no-install-recommends", "-y", *flags, str(package)],
            evidence, "deb-install")
    installed = command(["dpkg-query", "-W", "-f=${Version} ${Architecture}", "taomni"],
                        evidence, "deb-installed").stdout.decode().strip()
    if installed != f"{version} amd64":
        raise RuntimeError("The deb was not actually registered as installed")
    return Path("/usr/bin/taomni"), {"method": "apt-get install", "installedVersion": installed}


def windows_install(package, destination, evidence, *, version=RELEASE_VERSION):
    command(["msiexec.exe", "/i", str(package), "/qn", "/norestart",
             "INSTALLDIR=" + str(destination), "/L*v", str(evidence / "msi-install.log")],
            evidence, "msi-install", accepted=(0, 3010))
    executables = list(destination.rglob("taomni.exe"))
    if len(executables) != 1:
        raise RuntimeError("Legacy MSI did not install exactly one Taomni executable into INSTALLDIR")
    executable = executables[0].resolve()
    env = os.environ.copy()
    env["QA_LEGACY_INSTALLED_EXE"] = str(executable)
    script = """$ErrorActionPreference='Stop'
$exe=Get-Item -LiteralPath $env:QA_LEGACY_INSTALLED_EXE
@{fileVersion=$exe.VersionInfo.FileVersion;productVersion=$exe.VersionInfo.ProductVersion;
  signatureStatus=(Get-AuthenticodeSignature -LiteralPath $exe.FullName).Status.ToString()} |
  ConvertTo-Json -Compress
"""
    query = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]
    try:
        result = command(query, evidence, "installed-exe-query", env=env, timeout=30)
    except subprocess.TimeoutExpired:
        # Retry the metadata query. The MSI installation has already committed.
        result = command(query, evidence, "installed-exe-query-retry", env=env, timeout=90)
    (evidence / "installed-exe.json").write_bytes(result.stdout)
    details = json.loads(result.stdout.decode("utf-8-sig"))
    if details["productVersion"].split("+")[0] not in {version, f"{version}.0"}:
        raise RuntimeError("MSI installed an executable with an unexpected version")
    return executable, {"method": "msiexec /i (not administrative extraction)", **details}


def macos_install(package, destination, evidence, *, version=RELEASE_VERSION):
    mount = evidence / "dmg-mount"
    mount.mkdir()
    command(["hdiutil", "attach", str(package), "-readonly", "-nobrowse", "-mountpoint", str(mount)],
            evidence, "dmg-attach")
    try:
        apps = list(mount.glob("*.app"))
        if len(apps) != 1:
            raise RuntimeError("Legacy DMG must contain exactly one application")
        app = destination / apps[0].name
        command(["ditto", str(apps[0]), str(app)], evidence, "dmg-drag-install")
    finally:
        command(["hdiutil", "detach", str(mount)], evidence, "dmg-detach")
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if info["CFBundleShortVersionString"] != version or info["CFBundleIdentifier"] != "com.taomni.app":
        raise RuntimeError("Installed app has an unexpected identity/version")
    command(["codesign", "--verify", "--deep", "--strict", str(app)], evidence, "macos-signature")
    assessment = command(["spctl", "--assess", "--type", "execute", "--verbose=4", str(app)],
                         evidence, "macos-gatekeeper", accepted=(0, 1, 3))
    executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
    return executable, {"method": "DMG drag-install into run-owned Applications",
                        "bundleVersion": info["CFBundleShortVersionString"],
                        "gatekeeperExit": assessment.returncode,
                        "scope": "No quarantine bypass; direct CLI launch is not Gatekeeper acceptance evidence"}


def install(case_dir, work, *, version=RELEASE_VERSION, shared_msi_directory=None):
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != "engcapa/taomni":
        raise RuntimeError("Real legacy installation is allowed only on engcapa/taomni GitHub runners")
    case_dir = Path(case_dir).resolve()
    work = Path(work).resolve()
    work.mkdir(parents=True)
    evidence = case_dir / "legacy-install"
    evidence.mkdir()
    asset = selected_asset(version=version)
    staged = os.environ.get("QA_LEGACY_INSTALLER_DIR")
    if not staged:
        raise RuntimeError("The hosted job did not stage the pinned legacy installer")
    package = Path(staged) / asset.name
    verify_asset(package, asset)
    # Windows Installer registers one destination per product. Two cases can
    # reopen separate profiles from the same installed monolith in this shard.
    shared = platform.system() == "Windows" and shared_msi_directory is not None
    destination = shared_msi_directory if shared else work / "Applications"
    if destination.resolve() != destination:
        raise RuntimeError("Legacy installation refuses a linked application directory")
    destination.mkdir(exist_ok=shared)
    adapter = {"Linux": linux_install, "Windows": windows_install, "Darwin": macos_install}[platform.system()]
    options = {"allow_downgrade": True} if platform.system() == "Linux" else {}
    executable, details = adapter(package, destination, evidence, version=version, **options)
    if executable.is_symlink() or not executable.is_file():
        raise RuntimeError("Installed legacy executable is missing or linked")
    if platform.system() != "Linux" and not executable.resolve().is_relative_to(destination):
        raise RuntimeError("Legacy executable is outside its run-owned installation")
    receipt = {"schema": "taomni.qa.legacy-install.v1", "repository": "engcapa/taomni",
               "releaseId": release_assets(version)[0], "tag": f"v{version}", "assetId": asset.asset_id,
               "assetName": asset.name, "assetBytes": asset.size, "assetSha256": asset.sha256,
               "executable": str(executable), "executableSha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
               "installation": details, "system": platform.system(), "machine": platform.machine()}
    (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return executable, evidence
