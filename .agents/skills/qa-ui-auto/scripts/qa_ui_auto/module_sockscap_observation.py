"""Record the isolated writer lease across signed SocksCap parser calls."""

import json
import platform

from tauri_webdriver import WebDriverError

from .steps import StepError


def show_section(ctx, section, *, mode):
    if section not in ("upstream", "test"):
        raise StepError("show_sockscap_section: expected upstream or test")
    if getattr(ctx, "dry_run", False):
        return "dry-run; no SocksCap toggle action"
    selector = f'[data-testid="sockscap-section-{section}-toggle"]'
    if mode == "native":
        ctx.session.find('[data-testid="sockscap-capability-notes"]')
        if platform.system() == "Darwin":
            close = '[data-testid="sockscap-macos-setup-close"]'
            try:
                ctx.session.find(close, timeout=3)
            except WebDriverError:
                pass  # A profile with a ready Redirector does not show onboarding.
            else:
                ctx.session.click(close)
                ctx.session.wait_absent(close)
        expanded = ctx.session.execute(
            f"return document.querySelector({json.dumps(selector)})?.getAttribute('aria-expanded');",
        )
        if expanded == "false":
            ctx.session.click(selector)
    else:
        button = ctx.page.locator(selector)
        expanded = button.get_attribute("aria-expanded")
        if expanded == "false":
            button.click()
    if expanded not in {"false", "true"}:
        raise StepError(f"SocksCap {section} section is unavailable")
    return f"SocksCap {section} section is open"


def run(ctx, phase):
    from .fixtures.backup_policy import isolated_data_root
    from .fixtures.sockscap_legacy import SIGNED_CASES
    from .module_profile_observation import writer_lease

    owner = ctx.fixture_context
    receipt = getattr(owner, "signed_sockscap", None)
    if owner.case_id not in SIGNED_CASES or not receipt or phase not in {"idle", "running", "disabled"}:
        raise StepError("The SocksCap host observation requires its signed native case")
    observed = writer_lease(isolated_data_root(owner) / "plugins", slug="sockscap", enabled=phase == "running")
    result = {
        "phase": phase, "sourceSha": receipt["sourceSha"], "platform": receipt["platform"],
        "packageSha256": receipt["sha256"], "hostSha256": receipt["hostSha256"],
        "frontendSha256": receipt["frontendSha256"], "writerLease": observed,
    }
    (ctx.case_dir / f"signed-sockscap-{phase}.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8",
    )
    return f"SocksCap host writer lease verified ({phase})"


def resource_fixture(ctx, action):
    import hashlib
    import shutil
    import zipfile

    from .fixtures.sockscap_legacy import WINDOWS_CAPTURE_CASE_ID, XRAY_CASE_ID

    owner = ctx.fixture_context
    if owner.case_id not in {XRAY_CASE_ID, WINDOWS_CAPTURE_CASE_ID} or action not in {"alter", "restore"}:
        raise StepError("The SocksCap resource fixture requires its signed native case")
    path = owner.sockscap_resource
    receipt = owner.signed_sockscap
    if action == "alter":
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != receipt["resourceSha256"]:
                raise StepError("Installed module resource differs from the signed artifact before alteration")
        path.write_bytes(b"altered module resource fixture")
    elif action == "restore":
        archive_path, resource = owner.sockscap_resource_restore
        with zipfile.ZipFile(archive_path) as archive, archive.open(resource) as stream, path.open("wb") as current:
            shutil.copyfileobj(stream, current)
    with path.open("rb") as stream:
        sha = hashlib.file_digest(stream, "sha256").hexdigest()
    (ctx.case_dir / f"sockscap-resource-{action}.json").write_text(json.dumps({
        "sourceSha": receipt["sourceSha"], "packageSha256": receipt["sha256"],
        "stagedFilePresent": owner.sockscap_staged_resource.is_file(), "signedSha256": receipt["resourceSha256"], "resourceSha256": sha,
    }) + "\n", encoding="utf-8")
    return f"SocksCap resource {action} recorded"
