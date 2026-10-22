"""Real loopback failures must remain failures and release the owned session."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.deadline import Deadline
from tauri_webdriver import NativeSession, WebDriverError


class NativeCleanupTransportTest(TestCase):
    def setUp(self):
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_DELETE(self):
                self.server.requests.append(self.path)
                behavior = self.server.behavior
                if behavior == "stalled_headers":
                    self.server.release.wait(3)
                    self.close_connection = True
                    return
                body = (b'{"value":{"error":"unknown error","message":"refused"}}'
                        if behavior in {"http_error", "w3c_error"} else b'{"value":null}')
                self.send_response(500 if behavior == "http_error" else 200)
                self.send_header("Content-Length", str(len(body) + (10 if behavior in {
                    "stalled_body", "truncated_body"} else 0)))
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()
                if behavior == "stalled_body":
                    self.server.release.wait(3)
                if behavior in {"stalled_body", "truncated_body"}:
                    self.close_connection = True

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.requests = []
        self.server.release = threading.Event()
        self.server.behavior = "success"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.owner = Mock()
        self.session = NativeSession(f"http://127.0.0.1:{self.server.server_port}",
                                     Path("unused"), self.owner)
        self.session.session_id = "owned-session"
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.release.set()
        if self.session._connection:
            self.session._connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def assert_released(self):
        self.assertIsNone(self.session._connection)
        self.assertIsNone(self.session.session_id)
        self.owner.assert_called_once_with()
        self.assertEqual(self.server.requests, ["/session/owned-session"])
        self.assertEqual(self.session.cleanup_diagnostics["owner_cleanup"]["status"], "passed")

    def test_delete_success_is_observed_and_closes_transport(self):
        self.session.close()
        self.assert_released()
        request = self.session.cleanup_diagnostics["delete_request"]
        self.assertEqual((request["method"], request["phase"], request["http_status"]),
                         ("DELETE", "complete", 200))
        self.assertGreaterEqual(request["duration_sec"], 0)

    def test_stalled_response_headers_fail_without_retry_and_still_release_owner(self):
        self.assert_stalled("stalled_headers", "response_headers")

    def test_stalled_response_body_is_distinct_from_headers_and_owner_cleanup(self):
        self.assert_stalled("stalled_body", "response_body")

    def assert_stalled(self, behavior, expected_phase):
        self.server.behavior = behavior
        with patch("qa_ui_auto.deadline.Deadline", side_effect=lambda seconds: Deadline(0.15)) as budget:
            with self.assertRaises(TimeoutError):
                self.session.close()
        budget.assert_called_once_with(5)
        self.assert_released()
        request = self.session.cleanup_diagnostics["delete_request"]
        self.assertEqual(request["phase"], expected_phase)
        self.assertEqual(request["error_type"], "TimeoutError")

    def test_truncated_body_remains_an_error_even_after_owner_is_stopped(self):
        self.server.behavior = "truncated_body"
        with self.assertRaises(http.client.IncompleteRead):
            self.session.close()
        self.assert_released()
        self.assertEqual(self.session.cleanup_diagnostics["delete_request"]["phase"], "response_body")

    def test_http_error_is_not_retried_or_replaced_by_successful_owner_cleanup(self):
        self.server.behavior = "http_error"
        with self.assertRaisesRegex(WebDriverError, "HTTP 500"):
            self.session.close()
        self.assert_released()
        self.assertEqual(self.session.cleanup_diagnostics["delete_request"]["http_status"], 500)

    def test_w3c_error_is_not_treated_as_a_successful_response(self):
        self.server.behavior = "w3c_error"
        with self.assertRaisesRegex(WebDriverError, "refused"):
            self.session.close()
        self.assert_released()
        self.assertEqual(self.session.cleanup_diagnostics["delete_request"]["phase"], "decode_response")

    def test_owner_failure_remains_an_error_after_successful_delete(self):
        self.owner.side_effect = RuntimeError("owned process survives")
        with self.assertRaisesRegex(RuntimeError, "owned process survives"):
            self.session.close()
        self.assertIsNone(self.session._connection)
        self.assertEqual(self.session.cleanup_diagnostics["delete_request"]["phase"], "complete")
        owner = self.session.cleanup_diagnostics["owner_cleanup"]
        self.assertEqual((owner["status"], owner["error_type"]), ("failed", "RuntimeError"))

    def test_observations_do_not_include_execute_payload_or_response_content(self):
        secret = "qa-transport-private-value"
        self.session._local_endpoint = None
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps({"value": secret}).encode()
        self.session._open = Mock(return_value=response)
        self.assertEqual(self.session.request("POST", "/session/owned-session/execute/sync",
                                             {"script": secret, "args": [secret]}), secret)
        self.assertNotIn(secret, json.dumps(self.session.last_request))
        self.assertEqual(self.session.last_request["phase"], "complete")
