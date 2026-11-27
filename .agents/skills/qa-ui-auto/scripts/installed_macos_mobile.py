"""Check Mobile capture and OS input from the signed installed desktop on a loopback fixture."""

import base64
from io import BytesIO
import re

from PIL import Image
from installed_macos_store import compile_driver, controls, installed_macos_desktop
from modular_bundle_inventory import digest, write_json
from qa_ui_auto.fixtures.module_legacy_mfa import PASSWORD
from qa_ui_auto.mobile_desktop_remote import _start_target_server, _wait_state
from qa_ui_auto.mobile_wire import http


def observe_mobile(executable, work, evidence, source):
    folder = evidence / "mobile-desktop"
    record = {"sourceSha": source, "installedBinarySha256": digest(executable), "passed": False}
    driver = compile_driver(work)
    try:
        with installed_macos_desktop(executable, work, folder) as owner:
            record["ownerPid"] = owner.pid
            pair = controls(driver, owner, executable, "mobile-pair", folder, password=PASSWORD)
            endpoint = pair["endpoint"]
            if not re.fullmatch(r"http://127\.0\.0\.1:\d+", endpoint):
                raise RuntimeError("Installed Mobile did not start on loopback")
            status, _, device = http(endpoint, "/pair", body={
                "endpoint_label": "macOS installed desktop fixture", "pairing_code": pair["pairingCode"],
            }, origin=endpoint)
            if status != 200 or not device.get("token"):
                raise RuntimeError(f"Installed Mobile could not pair the test client (HTTP {status})")
            token = device["token"]
            status, _, denied = http(endpoint, "/desktop/screen", token, origin=endpoint)
            if status != 403 or denied.get("error") != "screen_capture_disabled":
                raise RuntimeError("Installed Mobile did not require capture opt-in")
            record["beforeOptIn"] = denied["error"]
            controls(driver, owner, executable, "mobile-opt-in", folder)
            server, lock, state = _start_target_server()
            try:
                status, _, opened = http(endpoint, "/desktop/browser", token, {
                    "url": f"http://127.0.0.1:{server.server_port}/",
                }, origin=endpoint)
                if status != 200 or opened.get("window_id") != "tauri:mobile-remote-browser":
                    raise RuntimeError(f"Mobile could not open the target browser (HTTP {status})")
                _wait_state(lock, state, lambda s: s["loaded"] > 0, "Target page did not load")
                status, _, screen = http(endpoint, "/desktop/screen", token, origin=endpoint)
                if status != 200 or screen.get("mime") != "image/png" or not screen.get("displays"):
                    raise RuntimeError(f"Mobile could not capture the screen (HTTP {status})")
                pixels = base64.b64decode(screen["image_b64"], validate=True)
                with Image.open(BytesIO(pixels)) as image:
                    image.load()
                    if image.format != "PNG" or image.size != (screen["width"], screen["height"]):
                        raise RuntimeError("Mobile returned an inconsistent screen image")
                (folder / "mobile-screen.png").write_bytes(pixels)
                record.update(screenSha256=digest(folder / "mobile-screen.png"), width=screen["width"],
                              height=screen["height"], displayCount=len(screen["displays"]))
                text = "QA_DESK_77"
                status, _, sent = http(endpoint, "/desktop/windows/tauri%3Amobile-remote-browser/input", token,
                                       {"text": text, "submit": True}, origin=endpoint)
                if status != 200 or not sent.get("ok"):
                    raise RuntimeError(f"Mobile could not send window input (HTTP {status})")
                def received(snapshot):
                    events = snapshot["events"]
                    return any(e.get("type") == "input" and e.get("value") == text for e in events) and any(
                        e.get("type") == "keydown" and e.get("key") == "Enter" and e.get("value") == text
                        for e in events
                    )
                observation = _wait_state(lock, state, received, "Target did not receive typed text and Enter")
                record["targetEvents"] = observation["events"]
            finally:
                server.shutdown()
                server.server_close()
            if owner.poll() is not None:
                raise RuntimeError("Installed desktop exited during the Mobile permission checks")
            # The installed core checks macOS Accessibility before sending window input.
            record.update(passed=True, accessibility="granted")
            return record
    finally:
        write_json(evidence / "installed-macos-mobile.json", record)
