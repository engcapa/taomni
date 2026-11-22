"""The Outbox observation ties delivery to the original row across module restarts."""
from contextlib import closing
from pathlib import Path
import json
import sqlite3
import tempfile
import unittest

from qa_ui_auto.module_mail_observation import observe_outbox
from qa_ui_auto.module_mail_contacts import EMAIL, NAME, observe
from qa_ui_auto.steps import StepError


class MailOutboxObservationTests(unittest.TestCase):
    def test_retains_identity_and_rejects_duplicate_or_premature_delivery(self):
        with tempfile.TemporaryDirectory() as root:
            module = Path(root, "module")
            legacy = Path(root, "legacy")
            module.mkdir()
            legacy.mkdir()
            path = module / "account.db"
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("CREATE TABLE mail_drafts(account_id,id,subject,to_json,text_body,reply_context_json)")
                db.execute("CREATE TABLE mail_draft_owners(account_id TEXT PRIMARY KEY)")
                db.execute("INSERT INTO mail_draft_owners VALUES ('acct')")
                db.execute("INSERT INTO mail_drafts VALUES(?,?,?,?,?,?)",
                           ("acct", "draft", "Signed Outbox ownership", '["receiver@example.com"]',
                            "Keep this scheduled draft", '{"outbox":{"sendAt":12345,"attempts":0}}'))
            queued = observe_outbox(module, legacy, "outbox-queued", None)
            self.assertEqual(queued["id"], "draft")
            self.assertEqual(observe_outbox(module, legacy, "outbox-retained", queued), queued)
            with self.assertRaisesRegex(StepError, "remove the original row"):
                observe_outbox(module, legacy, "outbox-sent", queued)
            copy = legacy / "duplicate.db"
            copy.write_bytes(path.read_bytes())
            with self.assertRaisesRegex(StepError, "legacy Mail cache"):
                observe_outbox(module, legacy, "outbox-retained", queued)
            copy.unlink()
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("UPDATE mail_drafts SET id='different'")
            with self.assertRaisesRegex(StepError, "changed the identity"):
                observe_outbox(module, legacy, "outbox-retained", queued)
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("DELETE FROM mail_drafts")
            self.assertFalse(observe_outbox(module, legacy, "outbox-sent", queued)["queued"])

class MailAddressBookObservationTests(unittest.TestCase):
    def test_requires_the_same_contact_in_the_owned_mailbox_until_deleted(self):
        with tempfile.TemporaryDirectory() as root:
            module = Path(root, "module")
            legacy = Path(root, "legacy")
            module.mkdir()
            legacy.mkdir()
            path = module / "account.db"
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("CREATE TABLE mail_cards(account_id,uid,card_json,display_name,emails,deleted)")
                db.execute("CREATE TABLE mail_address_book_owners(account_id PRIMARY KEY)")
                db.execute("INSERT INTO mail_cards VALUES(?,?,?,?,?,0)", (
                    "acct", "uid", json.dumps({"uid": "uid", "displayName": NAME, "emails": [EMAIL]}), NAME, EMAIL))
            with self.assertRaisesRegex(StepError, "claim the address book"):
                observe(module, legacy, "contact-saved", None)
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("INSERT INTO mail_address_book_owners VALUES ('acct')")
            saved = observe(module, legacy, "contact-saved", None)
            self.assertEqual(saved, observe(module, legacy, "contact-retained", saved))
            with self.assertRaisesRegex(StepError, "remove its exact row"):
                observe(module, legacy, "contact-deleted", saved)
            copy = legacy / "duplicate.db"
            copy.write_bytes(path.read_bytes())
            with self.assertRaisesRegex(StepError, "legacy cache"):
                observe(module, legacy, "contact-retained", saved)
            copy.unlink()
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("DELETE FROM mail_cards")
            self.assertTrue(observe(module, legacy, "contact-deleted", saved)["deleted"])
