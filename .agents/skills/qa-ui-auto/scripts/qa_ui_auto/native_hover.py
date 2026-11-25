"""Hover using the WebDriver pointer or the macOS system cursor for CSS hit testing."""
from pathlib import Path
import os
import platform
import subprocess

from native_pointer import prepare_pointer_target

from .deadline import budget_time as time
from .steps import StepError


def native_hover(ctx, selector: str, macos_system_pointer: bool) -> str:
    session = ctx.session
    session.activate_linux_window()
    origin = {"element-6066-11e4-a52e-4f735466cecf": session.find(selector, interactive=True)}
    if macos_system_pointer and platform.system() == "Darwin":
        point = prepare_pointer_target(session, origin)
        width, height = session.execute("return [innerWidth, innerHeight];")
        env = dict(os.environ, QA_HTML_APPLICATION=str(Path(session.application).resolve()),
                   QA_HTML_CLIENT_X=str(point["x"]), QA_HTML_CLIENT_Y=str(point["y"]),
                   QA_HTML_CLIENT_WIDTH=str(width), QA_HTML_CLIENT_HEIGHT=str(height),
                   QA_WEBVIEW_POINTER_ACTION="hover")
        result = subprocess.run(["osascript", "-l", "JavaScript", str(Path(__file__).with_name("html_preview_macos.js"))],
                                env=env, capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise StepError("macOS system hover failed: " + result.stderr.strip())
        return f"moved the system pointer to {selector}: {result.stdout.strip()}"
    session.request("POST", session.endpoint("/actions"), {"actions": [{
        "type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"},
        "actions": [{"type": "pointerMove", "duration": 150, "x": 0, "y": 0, "origin": origin}],
    }]})
    time.sleep(0.35)
    return f"hovered {selector}"
