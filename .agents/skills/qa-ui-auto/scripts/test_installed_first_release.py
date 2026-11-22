"""Pure observations for the installed desktop's enrollment and removal checks."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from installed_first_release import enrollment
from qa_ui_auto.module_marketplace_observation import current_roster_modules


class InstalledFirstReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.profile = Path(temporary.name)
        self.roster = {"taomni-plugin-" + slug: {"slug": slug} for slug in ["mail", "mfa", "rdp-client"]}
        self.origin = SimpleNamespace(roster=self.roster, current_catalog=b'{"sequence":42}')
        self.state = {"origin": "legacy", "legacyPending": [], "seen": list(self.roster), "newModules": []}
        self.cache = self.profile / "plugins/.catalog-trust/catalog.json"
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text(json.dumps({"payload": self.origin.current_catalog.decode()}))

    def test_only_the_exact_cached_catalog_and_frozen_members_complete_first_enrollment(self):
        state = self.profile / ".module-release.json"
        state.write_text(json.dumps(self.state))
        self.assertEqual(enrollment(self.profile, self.origin), self.state)
        for change in [{"origin": "fresh"}, {"newModules": [next(iter(self.roster))]}, {"seen": []}]:
            state.write_text(json.dumps({**self.state, **change}))
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, "enroll"):
                enrollment(self.profile, self.origin)
        state.write_text(json.dumps(self.state))
        self.cache.write_text(json.dumps({"payload": "another catalog"}))
        with self.assertRaisesRegex(RuntimeError, "different catalog"):
            enrollment(self.profile, self.origin)

    def test_store_checks_member_identity_even_when_the_visible_count_matches(self):
        session = Mock()
        session.execute.return_value = sorted(self.roster)
        self.assertEqual(current_roster_modules(session, self.roster), sorted(self.roster))
        session.execute.return_value = ["taomni-plugin-mfa", "taomni-plugin-rdp-client"]
        self.assertEqual(current_roster_modules(session, self.roster, "mail"), session.execute.return_value)
        session.execute.return_value = ["taomni-plugin-mail", "taomni-plugin-rdp-client"]
        with self.assertRaisesRegex(RuntimeError, "shows current modules"):
            current_roster_modules(session, self.roster, "mail")
