from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from native_application_restart import restart_owned_application


class NativeApplicationRestartTest(unittest.TestCase):
    def scenario(self):
        events = []
        deadline = object()
        session = SimpleNamespace(application=Path("qa-app"), session_id="old", deadline=deadline, transport="tauri-driver")
        def close():
            events.append("close")
            session.deadline = "cleanup-budget"
            session.session_id = None
        session.close = Mock(side_effect=close)
        def start():
            self.assertIs(session.deadline, deadline)
            events.append("start-session")
            session.session_id = "new"
        session.start = Mock(side_effect=start)
        driver = SimpleNamespace(stop=Mock(side_effect=lambda: events.append("stop-owner")),
                                 start=Mock(side_effect=lambda: events.append("start-owner")),
                                 mark_session_closed=Mock(), _restart_required=True,
                                 host="127.0.0.1", port=0, native_port=0)
        return session, driver, events

    def test_restarts_the_owned_process_without_resetting_profile_and_keeps_case_budget(self):
        session, driver, events = self.scenario()
        result = restart_owned_application(driver, session)
        self.assertEqual(events, ["close", "stop-owner", "start-owner", "start-session"])
        self.assertIs(session._on_close, driver.mark_session_closed)
        self.assertFalse(driver._restart_required)
        self.assertEqual((result["before_session"], result["after_session"]), ("old", "new"))

    def test_uncertain_close_releases_owner_and_never_starts_a_second_app(self):
        session, driver, _ = self.scenario()
        session.close.side_effect = RuntimeError("uncertain close")
        with self.assertRaisesRegex(RuntimeError, "uncertain close"):
            restart_owned_application(driver, session)
        driver.stop.assert_called_once()
        driver.start.assert_not_called()

    def test_failed_launch_stays_failed(self):
        session, driver, _ = self.scenario()
        session.start.side_effect = RuntimeError("launch failed")
        with self.assertRaisesRegex(RuntimeError, "launch failed"):
            restart_owned_application(driver, session)

    def test_reused_session_cannot_claim_a_cold_start(self):
        session, driver, _ = self.scenario()
        session.start.side_effect = lambda: setattr(session, "session_id", "old")
        with self.assertRaisesRegex(RuntimeError, "new native session"):
            restart_owned_application(driver, session)


if __name__ == "__main__":
    unittest.main()
