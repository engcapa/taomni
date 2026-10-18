"""Independent storage-oracle and real concurrent protocol fixture regressions."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import gzip
import hashlib
import imaplib
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from qa_ui_auto.mail_fake_server import FakeMailServer
from qa_ui_auto.mail_storage_oracle import observe, observe_incremental
from qa_ui_auto.mail_performance import percentile


class MailStorageOracleTest(unittest.TestCase):
    def test_complete_mime_and_cleanup_are_independently_checked(self):
        with tempfile.TemporaryDirectory(prefix="taomni-qa-mail-") as tmp:
            root = Path(tmp)
            raw = b'Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nbody\r\n--b\r\nContent-Disposition: attachment; filename=a.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAw==\r\n--b--\r\n'
            digest = hashlib.sha256(raw).hexdigest()
            with closing(sqlite3.connect(root / "qa.db")) as db, db:
                db.executescript('CREATE TABLE mail_full_messages(folder,uid,sha256,raw_size); CREATE TABLE mail_messages(folder,uid);')
                db.execute('INSERT INTO mail_full_messages VALUES(?,?,?,?)', ('INBOX', 7, digest, len(raw)))
                db.executemany('INSERT INTO mail_messages VALUES(?,?)', [('INBOX', 7), ('Archive', 8)])
            file = root / 'qa.mail' / 'objects' / digest[:2] / (digest + '.eml.gz')
            file.parent.mkdir(parents=True)
            file.write_bytes(gzip.compress(raw))
            expected = {'INBOX/7': {'sha256': digest, 'rawSize':len(raw), 'attachmentSha256':hashlib.sha256(bytes([0,1,2,3])).hexdigest()}}
            self.assertEqual(observe(root, expected, {'INBOX':1}, {'Archive':1})['objects'], 1)
            with closing(sqlite3.connect(root / 'qa.db')) as db, db:
                db.executescript("CREATE TABLE mail_folders(name,total,sync_complete); INSERT INTO mail_folders VALUES('INBOX',350,0);")
            self.assertEqual(observe_incremental(root, expected)['full'], 1)
            with closing(sqlite3.connect(root / 'qa.db')) as db, db:
                db.execute('UPDATE mail_folders SET sync_complete=1')
            with self.assertRaisesRegex(AssertionError, 'History must still be incomplete'):
                observe_incremental(root, expected)
            with closing(sqlite3.connect(root / 'qa.db')) as db, db:
                db.execute('UPDATE mail_folders SET sync_complete=0')
            file.write_bytes(gzip.compress(raw.replace(b'body', b'lost')))
            with self.assertRaisesRegex(AssertionError, 'integrity'):
                observe_incremental(root, expected)
            with self.assertRaisesRegex(AssertionError, 'integrity'):
                observe(root, expected, {'INBOX':1}, {'Archive':1})
            file.write_bytes(gzip.compress(raw))
            with closing(sqlite3.connect(root / 'qa.db')) as db, db:
                db.execute('DELETE FROM mail_full_messages')
            with self.assertRaisesRegex(AssertionError, 'No complete originals'):
                observe_incremental(root, expected)
            with self.assertRaisesRegex(AssertionError, 'Unreferenced'):
                observe(root, expected, {}, {'Archive':1})
            file.unlink()
            self.assertEqual(observe(root, expected, {}, {'Archive':1})['objects'], 0)

    def test_partial_fetch_and_overlapping_connections(self):
        server = FakeMailServer()
        try:
            uid = server.state.append_raw('INBOX', b'Subject: partial\r\n\r\nabcdef', [])
            server.state.archive_chunk_delay = .15
            barrier = threading.Barrier(2)
            def fetch():
                client = imaplib.IMAP4('127.0.0.1', server.imap_port)
                client.login('qa','qa');client.select('INBOX', readonly=True)
                barrier.wait(timeout=5)
                typ, data = client.uid('FETCH', str(uid), '(UID RFC822.SIZE BODY.PEEK[]<22.3>)')
                client.logout()
                self.assertEqual(typ, 'OK')
                return [part[1] for part in data if isinstance(part, tuple)]
            with ThreadPoolExecutor(max_workers=2) as pool:
                values = list(pool.map(lambda _:fetch(), range(2)))
            self.assertEqual(values, [[b'cde'], [b'cde']])
            self.assertGreaterEqual(server.state.fetch_max_parallel, 2)
            self.assertEqual(server.state.fetch_active, 0)
            self.assertEqual(len({e['thread'] for e in server.state.fetch_events}), 2)
        finally:
            server.stop()

    def test_percentiles_retain_slow_samples(self):
        self.assertEqual(percentile([1,2,3,4,5000], .95), 5000)
        with self.assertRaises(ValueError): percentile([], .95)


if __name__ == '__main__': unittest.main()
