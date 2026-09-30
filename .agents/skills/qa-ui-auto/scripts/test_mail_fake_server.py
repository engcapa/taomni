"""Protocol smoke tests for the native mail QA fake server (stdlib clients)."""

from __future__ import annotations

import imaplib
import smtplib
import unittest

from qa_ui_auto.mail_fake_server import FakeMailServer


class FakeMailServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = FakeMailServer()
        self.server.state.deliver("INBOX", 5, prefix="Seed")

    def tearDown(self) -> None:
        self.server.stop()

    def test_imap_examine_search_fetch_store(self) -> None:
        client = imaplib.IMAP4("127.0.0.1", self.server.imap_port)
        client.login("qa", "anything")
        typ, data = client.select("INBOX", readonly=True)
        self.assertEqual(typ, "OK")
        self.assertEqual(data, [b"5"])
        typ, data = client.uid("SEARCH", "UID", "3:*")
        self.assertEqual(data, [b"3 4 5"])
        # `n:*` beyond the max UID still matches the highest UID.
        typ, data = client.uid("SEARCH", "UID", "9:*")
        self.assertEqual(data, [b"5"])
        typ, data = client.uid("FETCH", "4:5", "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER])")
        self.assertEqual(typ, "OK")
        headers = [part[1] for part in data if isinstance(part, tuple)]
        self.assertEqual(len(headers), 2)
        self.assertIn(b"Subject: Seed 0004", headers[0])
        client.select("INBOX")
        client.uid("STORE", "4", "+FLAGS.SILENT", "(\\Seen)")
        typ, data = client.uid("SEARCH", "UNSEEN")
        self.assertEqual(data, [b"1 2 3 5"])
        client.logout()

    def test_condstore_changedsince_and_expunge(self) -> None:
        client = imaplib.IMAP4("127.0.0.1", self.server.imap_port)
        client.login("qa", "x")
        client.select("INBOX", readonly=True)
        typ, data = client._simple_command("EXAMINE", '"INBOX"', "(CONDSTORE)")
        self.assertEqual(typ, "OK")
        modseq = self.server.state.highest_modseq
        self.server.state.set_flags("INBOX", [2], ["\\Flagged"])
        typ, data = client.uid("FETCH", "1:5", f"(UID FLAGS) (CHANGEDSINCE {modseq})")
        fetched = [part for part in data if part]
        self.assertEqual(len(fetched), 1)
        self.assertIn(b"UID 2", fetched[0])
        self.server.state.expunge("INBOX", [1])
        self.assertEqual(self.server.state.count("INBOX"), 4)
        client.logout()

    def test_append_and_smtp(self) -> None:
        client = imaplib.IMAP4("127.0.0.1", self.server.imap_port)
        client.login("qa", "x")
        raw = b"Subject: sent copy\r\n\r\nhello\r\n"
        typ, data = client.append("Sent", "(\\Seen)", None, raw)
        self.assertEqual(typ, "OK")
        self.assertIn(b"APPENDUID", data[0])
        client.logout()
        with smtplib.SMTP("127.0.0.1", self.server.smtp_port) as smtp:
            smtp.sendmail("qa@example.com", ["to@example.com"], b"Subject: hi\r\n\r\nbody\r\n")
        self.assertEqual(self.server.state.smtp_messages[0]["to"], ["to@example.com"])


if __name__ == "__main__":
    unittest.main()
