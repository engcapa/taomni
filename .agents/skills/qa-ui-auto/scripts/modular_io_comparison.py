"""Paired native measurements for the modular M0 and release candidate installers."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from types import SimpleNamespace

from ci_desktop import Desktop
from qa_ui_auto.fixtures.module_legacy_mfa import installed_desktop, desktop_action, element
from qa_ui_auto.native_steps import NativeStepContext

TOOLS = Path(__file__).resolve().parent
EVIDENCE = Path("ac13-report").resolve()
CTX = SimpleNamespace(cfg={"webdriver": {"startup_timeout": 60}})


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def sample(key, attempt, packages, module):
    folder = EVIDENCE / f"{attempt}-{key}"
    folder.mkdir()
    package, expected = packages[key]
    subprocess.run(["sudo", "apt-get", "--reinstall", "install", "--no-install-recommends", "-y", str(package)], check=True)
    app = Path("/usr/bin/taomni")
    if sha(app) != expected:
        raise RuntimeError("Installed executable differs from selected DEB")
    with installed_desktop(CTX, app, folder / "isolated", folder, "desktop", timeout=120) as (_, session):
        desktop_action(NativeStepContext(session, folder, CTX.cfg), "wait_for", element("status-bar"))
        script = (TOOLS / "modular_io_probe.js").read_text()
        session.execute(script + "\nmeasureModularIo(" + json.dumps(module) + """).then(
          result => window.__ac13 = { result }, error => window.__ac13 = {error: String(error)}); return true;""")
        deadline = time.monotonic() + 75
        while time.monotonic() < deadline:
            result = session.execute("return window.__ac13 || null;")
            if result:
                if 'error' in result:
                    raise RuntimeError(result['error'])
                return result['result']
            time.sleep(0.25)
        raise RuntimeError("Timed out waiting for real terminal and installer measurements")


def main():
    if os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        raise SystemExit("use a disposable hosted desktop")
    EVIDENCE.mkdir(exist_ok=True)
    packages = {}
    record = {"sources": {}, "comparison": [], "runnerImage": os.environ["ImageVersion"],
              "verificationSha": os.environ["GITHUB_SHA"], "run": os.environ["GITHUB_RUN_ID"]}
    for key in ("baseline", "candidate"):
        directory = Path(key).resolve()
        package, = directory.glob("*.deb")
        unpacked = directory / "unpacked"
        subprocess.run(["dpkg-deb", "-x", str(package), str(unpacked)], check=True)
        binary = unpacked / "usr/bin/taomni"
        packages[key] = package, sha(binary)
        record["sources"][key] = {"packageSha256": sha(package), "binarySha256": sha(binary),
                                   "producer": json.loads((directory / 'producer.json').read_text())}
    spec = Path('module/signed-module').resolve()
    provenance = json.loads((spec/'provenance.json').read_text())
    expected = 'e0cb552e3d6a8c086fe302ac1df4df631dc4269f5d93379cc1ecb24c650b1c53'
    if provenance['sourceSha'] != 'cdbef387142cdf98bb5341fa6fab9d692b38c27f' or provenance['sha256'] != expected or sha(spec/provenance['archive']) != expected:
        raise RuntimeError("Historical signed benchmark package differs from the retained original")
    record['moduleProducer'] = {'runId':'44198966336', 'artifactId':'14379924062'}
    record["module"] = provenance
    module = dict(archive=str(spec/provenance['archive']), signature=(spec/provenance['signature']).read_text(),
                  moduleId=provenance['id'], version=provenance['version'], slug=provenance['slug'],
                  fixture=str(TOOLS/'modular_io_fixture.py'))
    try:
        with Desktop(EVIDENCE/'desktop', ['display','x11']):
            for attempt in range(10):
                order = ['baseline','candidate'] if attempt % 2 == 0 else ['candidate','baseline']
                for key in order:
                    entry = {"build":key,"pair":attempt,"samples":sample(key,attempt,packages,module)}
                    record['comparison'].append(entry)
                    (EVIDENCE/'samples.json').write_text(json.dumps(record,indent=2)+'\n')
        for row in record['comparison']:
            if len(row['samples']['moduleInstallMs']) != 5:
                raise RuntimeError(f"Historical install missing on {row['build']}: {row['samples'].get('installError')}")
    finally:
        (EVIDENCE/'samples.json').write_text(json.dumps(record,indent=2)+'\n')


if __name__ == "__main__":
    main()
