"""Accept real GNOME portal dialogs in the disposable CI desktop through AT-SPI.

The product still creates its own portal session and receives real PipeWire
frames. Only dialogs owned by this runtime's GNOME portal process are touched.
Every observed dialog and action is retained; no permission database is seeded.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import time


def owned_process(pid: int, runtime: str, executable: str, proc: Path = Path("/proc")) -> bool:
    try:
        process = proc / str(pid)
        return ((process / "exe").resolve(strict=True).name == executable
                and (b"XDG_RUNTIME_DIR=" + runtime.encode())
                in (process / "environ").read_bytes().split(b"\0"))
    except OSError:
        return False


def owned_portal(pid: int, runtime: str, proc: Path = Path("/proc")) -> bool:
    return owned_process(pid, runtime, "xdg-desktop-portal-gnome", proc)


def consent_kind(executable: str, records: list[dict]) -> str | None:
    names = {r["name"] for r in records if r["showing"]}
    if executable == "xdg-desktop-portal-gnome" and names.intersection({
            "Remote Desktop", "Screen Share", "Share Screen", "Screenshot"}):
        return "portal"
    # Non-interactive Screenshot first asks org.gnome.Shell's AccessDialog.
    # This is a Shell modal actor, absent from MetaWindow's toplevel list.
    if executable == "gnome-shell" and names.intersection({
            "Allow Apps to Take Screenshots?", "Allow to Take a Screenshot?",
            "Allow Taomni to Take Screenshots?", "Allow Taomni to Take a Screenshot?",
            "Allow Taomni QA to Take Screenshots?", "Allow Taomni QA to Take a Screenshot?",
            "Allow com.taomni.app.qa to Take Screenshots?",
            "Allow com.taomni.app.qa to Take a Screenshot?"}):
        return "screenshot-access"
    return None


def descendants(node, depth=0, max_depth=15):
    if depth > max_depth:
        return
    yield node
    try:
        count = min(node.get_child_count(), 200)
    except Exception:
        return  # The dialog may close between two accessibility reads.
    for index in range(count):
        try:
            child = node.get_child_at_index(index)
            if child is not None:
                yield from descendants(child, depth + 1, max_depth)
        except Exception:
            continue  # A vanished sibling must not hide the live Share button.


def accessible_record(node, types):
    state = node.get_state_set()
    action = node.get_action_iface()
    return {"name": node.get_name(), "role": node.get_role_name(),
            "showing": state.contains(types.SHOWING),
            "enabled": interactive_state(state, types),
            "checked": selected_state(state, types),
            "action_count": action.get_n_actions() if action else 0}


def observe_nodes(app, types, max_depth):
    pairs = []
    for node in descendants(app, max_depth=max_depth):
        try:
            pairs.append((node, accessible_record(node, types)))
        except Exception:
            continue
    return pairs


def interactive_state(state, types):
    # GTK4's AT-SPI backend maps GTK_ACCESSIBLE_STATE_DISABLED to SENSITIVE;
    # it does not set ENABLED at all (unlike GTK3 and GNOME Shell).
    return state.contains(types.ENABLED) or state.contains(types.SENSITIVE)


def selected_state(state, types):
    # GtkToggleButton uses PRESSED; GtkSwitch/CheckButton use CHECKED.
    return any(state.contains(value) for value in (types.CHECKED, types.PRESSED, types.SELECTED))


def activate_accessible(node, record, coordinates, click):
    """Use the accessible action, or actual pointer input at its screen bounds.

    GNOME Shell's St.Button exposes a component but its AT-SPI action does
    not activate AccessDialog. Callers already constrain process ownership,
    dialog title, showing/enabled state and the exact allowed button label.
    """
    action = node.get_action_iface()
    count = action.get_n_actions() if action else 0
    if count and action.do_action(0):
        return {"transport": "AT-SPI action", "action_count": count}
    component = node.get_component_iface()
    if not component:
        return {"transport": "unavailable", "action_count": count}
    rect = component.get_extents(coordinates)
    if rect.width <= 0 or rect.height <= 0 or rect.x < 0 or rect.y < 0:
        return {"transport": "unavailable", "action_count": count,
                "bounds": [rect.x, rect.y, rect.width, rect.height]}
    x, y = rect.x + rect.width // 2, rect.y + rect.height // 2
    click(x, y)
    return {"transport": "Mutter OS pointer at AT-SPI bounds", "action_count": count,
            "bounds": [rect.x, rect.y, rect.width, rect.height], "pointer": [x, y]}


def main():
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    from qa_ui_auto.wayland import command

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--ready", type=Path, required=True)
    args = parser.parse_args()
    runtime = os.environ["XDG_RUNTIME_DIR"]
    Atspi.init()
    Atspi.set_timeout(1000, 1000)
    args.ready.write_text(json.dumps({"transport": "AT-SPI", "runtime": runtime}))
    previous = {}
    def click(x, y):
        command("click", x=x, y=y, button="left")

    while True:
        try:
            desktop = Atspi.get_desktop(0)
            applications = []
            for index in range(desktop.get_child_count()):
                app = desktop.get_child_at_index(index)
                if app is None:
                    continue
                pid = app.get_process_id()
                executable = next((name for name in ("xdg-desktop-portal-gnome", "gnome-shell")
                                   if owned_process(pid, runtime, name)), None)
                if executable is None:
                    continue
                applications.append((executable, pid, app))
            # The Shell tree contains all mapped application surfaces. Read
            # actual portal consent first, and inspect Shell only while it has
            # a modal actor (Screenshot AccessDialog is not a MetaWindow).
            applications.sort(key=lambda item: item[0] != "xdg-desktop-portal-gnome")
            for executable, pid, app in applications:
                if executable == "gnome-shell" and not command("shell_modal"):
                    continue
                # GTK4/libadwaita stacks add structural accessible layers;
                # the monitor toggle can be deeper than a Shell dialog.
                pairs = observe_nodes(app, Atspi.StateType,
                                      30 if executable == "xdg-desktop-portal-gnome" else 15)
                records = [record for _, record in pairs]
                kind = consent_kind(executable, records)
                actions = []
                # With one monitor GNOME selects it automatically. Handle the
                # unselected preview too, using its accessible toggle action.
                for node, record in pairs:
                    if kind is None or not record["showing"] or not record["enabled"]:
                        continue
                    state = node.get_state_set()
                    if (kind == "portal" and record["role"] in {"toggle button", "check box", "switch"}
                            and not selected_state(state, Atspi.StateType)
                            and "remember" not in record["name"].lower()):
                        # AdwSwitchRow and its child GtkSwitch share a label.
                        # The row has no action; use the child's actual toggle.
                        if record["action_count"] == 0:
                            continue
                        result = activate_accessible(node, record, Atspi.CoordType.SCREEN, click)
                        actions.append({"name": record["name"], "action": "select", **result})
                        # Refresh the live states before toggling another
                        # control or activating Share; snapshots may be stale.
                        break
                    labels = {"Allow"} if kind == "screenshot-access" else {"Share", "Allow"}
                    if record["name"].replace("_", "") in labels and record["role"] in {"push button", "button"}:
                        result = activate_accessible(node, record, Atspi.CoordType.SCREEN, click)
                        actions.append({"name": record["name"], "action": "consent", **result})
                observation = {"pid": pid, "executable": executable, "kind": kind,
                               "tree": records, "actions": actions}
                signature = json.dumps(observation, sort_keys=True)
                if signature != previous.get(pid):
                    previous[pid] = signature
                    with args.log.open("a", encoding="utf-8") as stream:
                        stream.write(json.dumps({"time": time.time(), **observation}) + "\n")
        except Exception as error:
            with args.log.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps({"time": time.time(), "error": str(error)}) + "\n")
        time.sleep(0.25)


if __name__ == "__main__":
    main()
