"""Host oracles for macOS packaging and cancellation; no store mutation."""
import json
import plistlib
import subprocess

from . import updater_fixture
from .deadline import budget_time as time
from .native_steps import VERBS
from .steps import StepError


def active(ctx):
    fixture = updater_fixture.ACTIVE
    if fixture is None or fixture.case_dir != ctx.case_dir.resolve():
        raise StepError("Updater step requires the current case's macos_updater fixture")
    return fixture


def native_about(ctx, args):
    deadline = time.time() + 10
    last = None
    while time.time() < deadline:
        try:
            result = ctx.session.request("POST", ctx.session.endpoint("/qa/native-about"), {})
            return json.dumps(result)
        except Exception as error:
            last = error
            time.sleep(0.2)
    raise StepError(f"Installed native About menu could not be activated: {last}")


def fixture_mode(ctx, args):
    fixture = active(ctx)
    fixture.set_mode(args)
    return f"loopback fixture mode: {args}"


def release(ctx, args):
    fixture = active(ctx)
    index = int(args) - 1
    if index not in (0, 1):
        raise StepError("updater_release expects transfer 1 or 2")
    fixture.gates[index].set()
    return f"released real HTTP download {index + 1}"


def assert_installed(ctx, args):
    fixture = active(ctx)
    expected = fixture.expected.get(args)
    if expected is None:
        raise StepError("assert_updater_installed expects aarch64 or x86_64")
    actual_hash = updater_fixture.digest(fixture.executable)
    arch = subprocess.check_output(["lipo", "-archs", str(fixture.executable)], text=True).strip()
    with fixture.install_root.joinpath("Contents/Info.plist").open("rb") as stream:
        version = plistlib.load(stream)["CFBundleShortVersionString"]
    result = {"binary_sha256": actual_hash, "arch": arch, "version": version, "expected": expected}
    (ctx.case_dir / f"installed-{args}.json").write_text(json.dumps(result, indent=2))
    if actual_hash != expected["binary_sha256"] or version != expected["version"] or arch != ("arm64" if args == "aarch64" else "x86_64"):
        raise StepError(f"Installed app differs from signed {args} release: {result}")
    return json.dumps(result)


def assert_unchanged(ctx, args):
    fixture = active(ctx)
    actual_hash = updater_fixture.digest(fixture.executable)
    if actual_hash != fixture.baseline:
        raise StepError("A rejected or cancelled update changed the disposable app")
    return f"disposable app unchanged: {actual_hash}"


def assert_progress(ctx, args):
    fixture = active(ctx)
    seconds = float(args.get("seconds", 2))
    minimum = int(args.get("min", 0))
    maximum = int(args.get("max", 100))
    old_done = args.get("old_transfer_done", False)
    samples = []
    deadline = time.time() + seconds
    while time.time() < deadline:
        observation = ctx.session.execute(
            "const dialog = document.querySelector('[data-testid=\"update-dialog\"]');"
            "const progress = document.querySelector('[data-testid=\"update-progress\"]');"
            "return {status: dialog?.getAttribute('data-status'), percent: progress?.getAttribute('aria-valuenow')};"
        )
        samples.append(observation)
        if observation.get("status") != "downloading" or observation.get("percent") is None:
            raise StepError(f"Expected an active retry download: {observation}")
        percent = int(observation["percent"])
        if not minimum <= percent <= maximum or (len(samples) > 1 and percent < int(samples[-2]["percent"])):
            raise StepError(f"Download progress regressed or escaped {minimum}..{maximum}: {samples}")
        time.sleep(0.1)
    artifact = ctx.case_dir / ("retry-progress-after-old.json" if old_done else "retry-progress.json")
    artifact.write_text(json.dumps(samples, indent=2))
    if old_done and not fixture.done[0].is_set():
        raise StepError("The cancelled download did not finish delivering its real late bytes")
    if old_done:
        assert_unchanged(ctx, None)
    return f"{len(samples)} monotone native progress samples: {minimum}..{maximum}"


VERBS.update({
    "native_about": native_about,
    "updater_fixture_mode": fixture_mode,
    "updater_release": release,
    "assert_updater_installed": assert_installed,
    "assert_updater_unchanged": assert_unchanged,
    "assert_updater_progress": assert_progress,
})
