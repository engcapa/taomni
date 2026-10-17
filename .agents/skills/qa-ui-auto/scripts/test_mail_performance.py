"""Protocol readiness and timestamp boundaries for native mail measurements."""
from __future__ import annotations

import imaplib
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

from qa_ui_auto.mail_fake_server import FakeMailServer
from qa_ui_auto.mail_performance import fetches_during_samples, wait_for_archive_fetch
from qa_ui_auto.steps import StepError


class MailPerformanceTest(unittest.TestCase):
    def test_waits_for_actual_resumed_chunk_and_records_overlap(self):
        server = FakeMailServer()
        uid, = server.state.deliver("INBOX", 1)
        server.state.archive_chunk_delay = .4
        target = {"folder": "INBOX", "uid": uid, "min_offset": 16}
        start_fetch = threading.Event()

        def fetch():
            with imaplib.IMAP4("127.0.0.1", server.imap_port) as client:
                client.login("qa", "x")
                client.select("INBOX", readonly=True)
                start_fetch.wait(3)
                return client.uid("FETCH", str(uid), "(UID RFC822.SIZE BODY.PEEK[]<16.32>)")

        try:
            with ThreadPoolExecutor(max_workers=2) as workers:
                request = workers.submit(fetch)
                readiness = workers.submit(wait_for_archive_fetch, server.state, target, 3)
                # Neither an idle server nor a previously finished FETCH is ready.
                self.assertRaises(TimeoutError, readiness.result, timeout=.05)
                start_fetch.set()
                ready = readiness.result(timeout=3)
                self.assertEqual(ready["target"], target)
                self.assertEqual(len(ready["activeFetches"]), 1)
                with server.state.lock:
                    self.assertEqual(server.state.fetch_active, 1)
                    self.assertEqual(server.state.fetch_events, [])
                started = time.monotonic()
                self.assertEqual(request.result(timeout=3)[0], "OK")
                finished = time.monotonic()
                with server.state.lock:
                    events = list(server.state.fetch_events)
                    self.assertEqual(server.state.fetch_active, 0)
                    self.assertEqual(server.state.fetch_inflight, [])
                self.assertEqual(len(fetches_during_samples(events, [{"started": started, "finished": finished}], target)), 1)
        finally:
            start_fetch.set()
            server.stop()

    def test_unrelated_or_finished_fetch_cannot_satisfy_readiness(self):
        server = FakeMailServer()
        uid, = server.state.deliver("INBOX", 1)
        try:
            with imaplib.IMAP4("127.0.0.1", server.imap_port) as client:
                client.login("qa", "x")
                client.select("INBOX", readonly=True)
                client.uid("FETCH", str(uid), "(UID RFC822.SIZE BODY.PEEK[]<16.32>)")
            target = {"folder": "INBOX", "uid": uid, "min_offset": 16}
            with self.assertRaisesRegex(StepError, "did not become active"):
                wait_for_archive_fetch(server.state, target, timeout=.03)
        finally:
            server.stop()

    def test_only_target_archive_progress_inside_ui_sample_counts(self):
        target = {"folder": "INBOX", "uid": 33, "min_offset": 262144, "exclude_connections": [100]}
        event = {"folder": "INBOX", "command": "UID FETCH 33 (UID RFC822.SIZE BODY.PEEK[]<262144.262144>)",
                 "connection": 101, "started": 10.1, "finished": 10.4}
        intervals = [{"started": 10, "finished": 10.3}, {"started": 10.5, "finished": 10.8}]
        self.assertEqual(fetches_during_samples([event], intervals, target), [event])
        rejected = [
            {**event, "started": 9, "finished": 9.9},  # Before sampling.
            {**event, "finished": 10.9},  # Completion after the last probe.
            {**event, "started": 10.35, "finished": 10.45},  # Between probes.
            {**event, "folder": "Archive"},
            {**event, "connection": 100},  # Cancelled owner finishing late.
            {**event, "command": "UID FETCH 34 (UID BODY.PEEK[]<262144.262144>)"},
            {**event, "command": "UID FETCH 33 (UID BODY.PEEK[]<0.262144>)"},
            {**event, "command": "UID FETCH 33 (UID BODY.PEEK[HEADER] BODY.PEEK[]<262144.262144>)"},
        ]
        self.assertEqual(fetches_during_samples(rejected, intervals, target), [])


if __name__ == "__main__":
    unittest.main()
