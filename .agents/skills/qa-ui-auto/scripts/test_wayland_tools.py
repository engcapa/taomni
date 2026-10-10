import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from ci_wayland_portal import owned_portal, owned_process, consent_kind, consent_control, activate_accessible, interactive_state, selected_state, descendants, observe_nodes
from ci_wayland_input import focus_window, move_pointer, owned_window_pid
from qa_ui_auto import host_clipboard, wayland
from qa_ui_auto.native_steps import _read_wayland_clipboard


class WaylandToolsTests(unittest.TestCase):
    def control(self, name, role, *, checked=False, enabled=True, showing=True, actions=1):
        return Mock(), dict(name=name, role=role, checked=checked, enabled=enabled,
                            showing=showing, action_count=actions)

    def test_single_monitor_selection_reaches_share_with_two_exclusive_previews(self):
        first = self.control("MetaVendor", "toggle button")
        second = self.control("MetaVendor", "toggle button")
        share = self.control("Share", "button", enabled=False)
        pairs = [first, second, share]
        self.assertEqual(consent_control(pairs, "portal"), (*first, "select"))
        # GTK's live snapshot after selecting one exclusive preview. The
        # other stays unchecked; selecting it would deselect the first.
        first[1]["checked"] = True
        share[1]["enabled"] = True
        self.assertEqual(consent_control(pairs, "portal"), (*share, "consent"))
        first[1]["checked"], second[1]["checked"] = False, True
        self.assertEqual(consent_control(pairs, "portal"), (*share, "consent"))

    def test_remote_interaction_uses_actionable_switch_then_retains_selection(self):
        row = self.control("Allow Remote Interaction", "switch", actions=0)
        switch = self.control("Allow Remote Interaction", "switch")
        label = self.control("Allow Remote Interaction", "label", actions=8)
        monitor = self.control("MetaVendor", "toggle button", checked=True)
        remember = self.control("Remember this decision", "check box")
        share = self.control("Share", "button")
        pairs = [row, label, switch, monitor, remember, share]
        self.assertEqual(consent_control(pairs, "portal"), (*switch, "select"))
        row[1]["checked"] = switch[1]["checked"] = True
        self.assertEqual(consent_control(pairs, "portal"), (*share, "consent"))

    def test_consent_never_activates_unknown_hidden_or_disabled_controls(self):
        allow = self.control("Allow", "button")
        self.assertIsNone(consent_control([allow], None))
        self.assertIsNone(consent_control([allow], "global-shortcuts"))
        self.assertEqual(consent_control([allow], "screenshot-access"), (*allow, "consent"))
        for property in ("enabled", "showing"):
            with self.subTest(property=property):
                pair = self.control("Share", "button", **{property: False})
                self.assertIsNone(consent_control([pair], "portal"))
        # An unselected preview without an accessible action is not consent.
        self.assertIsNone(consent_control([
            self.control("MetaVendor", "toggle button", actions=0),
            self.control("Share", "button")], "portal"))

    def test_auxiliary_x11_allowance_retains_wayland_input_transport(self):
        with patch.dict(os.environ, {"GDK_BACKEND": "wayland,x11"}, clear=True):
            self.assertTrue(wayland.active())
            with self.assertRaisesRegex(RuntimeError, "owned desktop input socket"):
                wayland.command("keys", chords=[[65]])

    def test_vanished_accessibility_siblings_do_not_hide_live_consent(self):
        app, stale, share = Mock(), Mock(), Mock()
        app.get_child_count.return_value = 3
        app.get_child_at_index.side_effect = [RuntimeError("object vanished"), stale, share]
        stale.get_child_count.side_effect = RuntimeError("object vanished")
        share.get_child_count.return_value = 0
        self.assertEqual(list(descendants(app)), [app, stale, share])
        with patch("ci_wayland_portal.descendants", return_value=iter([stale, share])), \
             patch("ci_wayland_portal.accessible_record", side_effect=[RuntimeError("object vanished"), {"name": "Share"}]):
            self.assertEqual(observe_nodes(app, Mock(), 30), [(share, {"name": "Share"})])

    def test_selected_monitor_toggle_is_not_deselected_when_gtk_uses_pressed(self):
        types = Mock(CHECKED='checked', PRESSED='pressed', SELECTED='selected')
        for present, expected in (({'pressed'}, True), ({'checked'}, True), ({'selected'}, True), (set(), False)):
            state = Mock()
            state.contains.side_effect = present.__contains__
            self.assertEqual(selected_state(state, types), expected)

    def test_gtk4_sensitive_controls_and_gtk3_enabled_controls_are_interactive(self):
        types = Mock(ENABLED='enabled', SENSITIVE='sensitive')
        for present, expected in (({'sensitive'}, True), ({'enabled'}, True), (set(), False)):
            state = Mock()
            state.contains.side_effect = present.__contains__
            self.assertEqual(interactive_state(state, types), expected)

    def test_owned_consent_component_uses_real_pointer_when_action_cannot_activate(self):
        node = Mock()
        node.get_action_iface.return_value.get_n_actions.return_value = 1
        node.get_action_iface.return_value.do_action.return_value = False
        rect = Mock(x=800, y=500, width=120, height=40)
        node.get_component_iface.return_value.get_extents.return_value = rect
        click = Mock()
        result = activate_accessible(node, {}, 'screen', click)
        click.assert_called_once_with(860, 520)
        self.assertEqual(result['pointer'], [860, 520])
        self.assertEqual(result['transport'], 'Mutter OS pointer at AT-SPI bounds')
        node.get_action_iface.return_value.do_action.return_value = True
        click.reset_mock()
        self.assertEqual(activate_accessible(node, {}, 'screen', click)['transport'], 'AT-SPI action')
        click.assert_not_called()
        node.get_action_iface.return_value.do_action.return_value = False
        rect.width = 0
        self.assertEqual(activate_accessible(node, {}, 'screen', click)['transport'], 'unavailable')
        click.assert_not_called()

    def test_named_window_retains_executable_runtime_and_uniqueness_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / 'taomni-qa'
            executable.touch()
            owned_runtime = root / 'qa-owned'
            for pid, runtime in ((42, str(owned_runtime)), (43, str(root / 'personal'))):
                process = root / str(pid)
                process.mkdir()
                (process / 'environ').write_bytes(('XDG_RUNTIME_DIR=' + runtime + '\0').encode())
            windows = [dict(pid=42, title='Main'), dict(pid=42, title='Pinned Screenshot'),
                       dict(pid=43, title='Other')]
            with patch.object(Path, 'resolve', return_value=executable):
                self.assertEqual(owned_window_pid(windows, executable, owned_runtime,
                                                 root, title='Pinned Screenshot'), 42)
                for title in ('Other', 'Missing'):
                    with self.assertRaisesRegex(RuntimeError, 'found 0'):
                        owned_window_pid(windows, executable, owned_runtime, root, title=title)
                with self.assertRaisesRegex(RuntimeError, 'found 2'):
                    owned_window_pid(windows, executable, owned_runtime, root)
                with self.assertRaisesRegex(RuntimeError, 'found 2'):
                    owned_window_pid(windows + [windows[1]], executable, owned_runtime,
                                     root, title='Pinned Screenshot')
            def resolve(path, **kwargs):
                return root / 'other-app' if path.name == 'exe' else executable
            with patch.object(Path, 'resolve', resolve):
                with self.assertRaisesRegex(RuntimeError, 'found 0'):
                    owned_window_pid(windows, executable, owned_runtime, root,
                                     title='Pinned Screenshot')

    def test_main_window_ignores_owned_tooltips_but_rejects_two_toplevels(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / 'taomni-qa'
            executable.touch()
            runtime = root / 'qa-owned'
            process = root / '42'
            process.mkdir()
            (process / 'environ').write_bytes(('XDG_RUNTIME_DIR=' + str(runtime) + '\0').encode())
            main = dict(pid=42, title='Main', normal=True)
            tooltip = dict(pid=42, title='Drag window', normal=False)
            with patch.object(Path, 'resolve', return_value=executable):
                self.assertEqual(owned_window_pid([tooltip, main], executable, runtime, root), 42)
                self.assertEqual(owned_window_pid([tooltip, main], executable, runtime,
                                                 root, title='Drag window'), 42)
                with self.assertRaisesRegex(RuntimeError, 'found 0'):
                    owned_window_pid([tooltip], executable, runtime, root)
                with self.assertRaisesRegex(RuntimeError, 'found 2'):
                    owned_window_pid([main, dict(main, title='Other')], executable, runtime, root)

    def test_consent_only_accepts_known_dialogs_from_their_owning_process(self):
        def records(name, showing=True):
            return [{"name": name, "showing": showing}]
        self.assertEqual(consent_kind("gnome-shell", records("Allow Apps to Take Screenshots?")), "screenshot-access")
        self.assertEqual(consent_kind("xdg-desktop-portal-gnome", records("Screenshot")), "portal")
        self.assertEqual(consent_kind("xdg-desktop-portal-gnome", records("Remote Desktop")), "portal")
        self.assertIsNone(consent_kind("gnome-shell", records("Allow Apps to Use the Microphone?")))
        self.assertIsNone(consent_kind("other-process", records("Screenshot")))
        self.assertIsNone(consent_kind("gnome-shell", records("Allow Apps to Take Screenshots?", False)))
        provider = "gnome-control-center-global-shortcuts-provider"
        self.assertEqual(consent_kind(provider, records("Add Keyboard Shortcuts")), "global-shortcuts")
        self.assertIsNone(consent_kind(provider, records("Microphone")))

    def test_pointer_waits_for_queued_motion_and_rejects_a_nonmoving_device(self):
        evaluate = Mock(side_effect=[[0, 0], [0, 0], [24, 18]])
        notify = Mock()
        with patch("ci_wayland_input.time.sleep"):
            self.assertEqual(move_pointer(evaluate, notify, 24, 18), [24, 18])
        self.assertEqual(notify.call_count, 2)
        with patch("ci_wayland_input.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "did not reach"):
                move_pointer(Mock(return_value=[0, 0]), notify, 24, 18)

    def test_absolute_pointer_waits_for_observed_logical_position_across_dpi_seam(self):
        evaluate = Mock(side_effect=[[1919, 292], [1920, 292], [1936, 16]])
        notify = Mock()
        with patch("ci_wayland_input.time.sleep"):
            self.assertEqual(move_pointer(evaluate, notify, 1936, 16, absolute=True), [1936, 16])
        self.assertEqual(notify.call_args_list, [((1936.0, 16.0),), ((1936.0, 16.0),)])
        with patch("ci_wayland_input.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "did not reach"):
                move_pointer(Mock(return_value=[1920, 16]), notify, 1936, 16, absolute=True)

    def test_fixture_readiness_waits_for_os_focus_and_reports_real_geometry(self):
        rect = {"x": 120, "y": 80, "width": 600, "height": 400}
        window = {"pid": 42, "focused": True, "frame": rect}
        evaluate = Mock(side_effect=[True,
            {"overview": True, "windows": [window]},
            {"overview": False, "windows": [window]}])
        diagnostics = {}
        with patch("ci_wayland_input.time.sleep"):
            self.assertEqual(focus_window(evaluate, 42, diagnostics)["frame"], rect)
        self.assertEqual(evaluate.call_count, 3)
        self.assertFalse(diagnostics["after"]["overview"])

    def test_focus_dismisses_an_overview_actor_that_still_intercepts_input(self):
        window = {"pid": 42, "focused": True}
        evaluate = Mock(side_effect=[True,
            {"overview": True, "overview_visible": False, "overview_animating": False,
             "overview_actor_visible": True, "windows": [window]},
            True, {"overview": False, "windows": [window]}])
        diagnostics = {}
        with patch("ci_wayland_input.time.sleep"):
            self.assertEqual(focus_window(evaluate, 42, diagnostics), window)
        self.assertIn("hideOverview()", evaluate.call_args_list[2].args[0])
        self.assertFalse(diagnostics["after"]["overview"])

    def test_portal_automation_rejects_other_runtime_and_non_portal_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "xdg-desktop-portal-gnome"
            binary.touch()
            process = root / "42"
            process.mkdir()
            # /proc/PID/exe resolves to the actual executable. Avoid symlink
            # privileges on the Windows test host by patching only that read.
            (process / "environ").write_bytes(b"XDG_RUNTIME_DIR=/tmp/qa-owned\0")
            with patch.object(Path, "resolve", return_value=binary):
                self.assertTrue(owned_portal(42, "/tmp/qa-owned", root))
                self.assertFalse(owned_portal(42, "/tmp/personal", root))
                self.assertFalse(owned_portal(43, "/tmp/qa-owned", root))
            with patch.object(Path, "resolve", return_value=root / "other-app"):
                self.assertFalse(owned_portal(42, "/tmp/qa-owned", root))
            with patch.object(Path, "resolve", return_value=root / "gnome-shell"):
                self.assertTrue(owned_process(42, "/tmp/qa-owned", "gnome-shell", root))
                self.assertFalse(owned_process(42, "/tmp/personal", "gnome-shell", root))

    def test_missing_owned_socket_fails_without_x11_fallback(self):
        with patch.dict(os.environ, {"GDK_BACKEND": "wayland"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "owned desktop input socket"):
                wayland.command("keys", chords=[[65]])

    def test_invalid_external_utf8_is_a_real_conversion_failure(self):
        with patch("qa_ui_auto.native_steps.subprocess.run", return_value=Mock(stdout=b"\xff")) as run:
            self.assertFalse(_read_wayland_clipboard()["ok"])
            self.assertEqual(run.call_args.args[0][0], "wl-paste")
        with patch("qa_ui_auto.native_steps.subprocess.run", return_value=Mock(stdout="中文\n".encode())):
            self.assertEqual(_read_wayland_clipboard(), {"ok": True, "text": "中文\n"})

    def test_wayland_clipboard_image_oracle_retains_exact_png_bytes(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, {"GDK_BACKEND": "wayland", "WAYLAND_DISPLAY": "wayland-qa"}), \
             patch.object(host_clipboard, "SYSTEM", "Linux"), \
             patch.object(host_clipboard, "_run", return_value=b"\x89PNG\r\n\x00\xff") as run, \
             patch.object(host_clipboard, "_xclip_get") as x11:
            target = Path(directory) / "image.png"
            host_clipboard.save_image(target)
            self.assertEqual(target.read_bytes(), b"\x89PNG\r\n\x00\xff")
            self.assertIn("image/png", run.call_args.args[0])
            x11.assert_not_called()

    def test_clipboard_quiet_counts_ownership_notifications_even_for_identical_payloads(self):
        with patch.dict(os.environ, {"GDK_BACKEND": "wayland", "WAYLAND_DISPLAY": "wayland-qa"}), \
             patch.object(host_clipboard, "SYSTEM", "Linux"), \
             patch("qa_ui_auto.wayland.command", side_effect=[12, 15]) as command, \
             patch.object(host_clipboard.time, "sleep"), \
             patch.object(host_clipboard, "get_text") as read:
            self.assertEqual(host_clipboard.count_changes(1), 3)
            read.assert_not_called()
            self.assertEqual(command.call_count, 2)


if __name__ == "__main__":
    unittest.main()
