"""Retain pre-teardown evidence when normal native restart fails."""
import json
from pathlib import Path
import uuid

from qa_ui_auto.deadline import Deadline

CLOSE_TARGET = """
const target = document.querySelector('[data-testid="window-close"]');
const describe = el => el ? {tag:el.tagName, id:el.id,
  testId:el.getAttribute('data-testid'), role:el.getAttribute('role'),
  pointerEvents:getComputedStyle(el).pointerEvents} : null;
if (!target) return {target:null};
const r = target.getBoundingClientRect(), x = (r.left+r.right)/2, y = (r.top+r.bottom)/2;
return {target:describe(target), rect:{x:r.x,y:r.y,width:r.width,height:r.height},
  viewport:{width:innerWidth,height:innerHeight},
  hit:document.elementsFromPoint(x,y).map(describe)};
"""


def capture(session, observation):
    path = getattr(session, "pointer_observations_path", None)
    if not isinstance(path, Path):
        return
    old_deadline = session.deadline
    session.deadline = Deadline(3)
    try:
        folder = path.parent / "native-restart-failures" / uuid.uuid4().hex
        folder.mkdir(parents=True)
        observation["before_release_artifacts"] = artifacts = {}
        for name, action in (
            ("screenshot", lambda: session.screenshot(folder / "webview.png")),
            ("close_target", lambda: save_json(folder / "close-target.json", session.execute(CLOSE_TARGET))),
            ("html", lambda: save_html(folder / "webview.html", session.execute("return document.documentElement.outerHTML;"))),
        ):
            try:
                artifacts[name] = action()
            except Exception as error:
                observation.setdefault("diagnostic_errors", []).append(f"{name}: {error}")
    except Exception as error:
        observation.setdefault("diagnostic_errors", []).append(f"before release: {error}")
    finally:
        session.deadline = old_deadline


def save_json(path, value):
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")
    return str(path)


def save_html(path, value):
    if not isinstance(value, str):
        raise ValueError("Native restart diagnostic returned no document")
    path.write_text(value, encoding="utf-8")
    return str(path)
