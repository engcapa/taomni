"""Native Host-policy oracle; UI owns config, loopback HTTP owns the verdict.

The host-policy argument of mobile_service_probe requires the Settings listener
running on port 0 and an unused visible pairing code. No IPC/config writers,
DNS, environment proxies, personal profiles or external servers are used.
"""
from __future__ import annotations

from contextlib import suppress
import http.client
import json
from urllib.parse import urlsplit

from .mobile_wire import Ws
from .steps import StepError
from .terminal_burst_probe import until

HOSTS = ("qa-proxy.example.invalid", "qa-proxy-port.example.invalid:18443")
ARBITRARY = "unlisted.example.invalid"
ORIGIN = "https://mobile-host-policy.qa.invalid"
UNPAIRED_ORIGIN = "https://unpaired-mobile-host-policy.qa.invalid"
INPUT = '[data-testid="mobile-settings-allowed-hosts"]'
ALL = '[data-testid="mobile-settings-allow-all-hosts"]'
SAVE = '[data-testid="mobile-settings-save-hosts"]'
SAVED = '[data-testid="mobile-settings-hosts-saved"]'
STATUS = '[data-testid="mobile-settings-status"]'


def request(endpoint, path, host, *, token=None, origin=None, body=None):
    """Send an exact Host header to the displayed loopback listener, no redirects.

    HTTPConnection has no environment/system proxy lookup. Never resolve the
    synthetic Host value or send a pairing secret to a non-loopback endpoint.
    """
    url = urlsplit(endpoint)
    if (url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
            or url.username or url.password or url.path not in ("", "/")
            or url.query or url.fragment):
        raise StepError("Mobile Host oracle requires a plain loopback listener")
    headers = {"Host": host}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    if origin is not None:
        headers["Origin"] = origin
    raw = None
    if body is not None:
        raw = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    connection = http.client.HTTPConnection("127.0.0.1", url.port, timeout=15)
    try:
        connection.request("POST" if body is not None else "GET", path, raw, headers)
        response = connection.getresponse()
        raw = response.read()
        value = json.loads(raw) if raw and "application/json" in response.getheader("Content-Type", "") else None
        return response.status, value
    finally:
        connection.close()


def read(ctx, selector, prop):
    return ctx.session.execute("return document.querySelector(" + json.dumps(selector) + ")?." + prop)


def save_hosts(ctx, *, allow_all, replace_hosts=False):
    """Use actual textarea/checkbox and focused Save; never synthesize state."""
    if replace_hosts:
        ctx.session.fill(INPUT, "\n".join(HOSTS))
    checked = read(ctx, ALL, "checked")
    if not isinstance(checked, bool):
        raise StepError("Mobile allow-all checkbox is missing")
    if checked != allow_all:
        ctx.session.click(ALL)
    until(ctx.session, "!!document.querySelector(" + json.dumps(SAVE) + ") && !document.querySelector("
          + json.dumps(SAVE) + ").disabled")
    # Settings search can smooth-scroll while pointer input is delivered. The
    # focused real button gives one activation, without replaying clicks/IPC.
    ctx.session.focus(SAVE)
    ctx.session.press_combo("Enter")
    until(ctx.session, "!!document.querySelector(" + json.dumps(SAVED) + ")?.textContent.trim() && "
          "!document.querySelector(" + json.dumps(SAVE) + ")?.disabled")
    if read(ctx, ALL, "checked") is not allow_all:
        raise StepError("Saved mobile allow-all value does not match its control")
    if read(ctx, INPUT, "value") != "\n".join(HOSTS):
        raise StepError("Toggling allow-all discarded or changed the explicit allowlist")


def run(ctx, endpoint, pairing_code):
    """Default deny -> exact hosts -> all hosts -> live restriction, one socket.

    Receipt contains only request/status/error labels, never pairing codes,
    Bearer tokens, ticket values or successful pairing payloads. Failures retain
    the phase and completed checks, and always close the owned event socket.
    """
    receipt = {"passed": False, "phase": "default", "checks": []}
    destination = ctx.case_dir / "mobile-host-policy-receipt.json"
    socket = None
    loopback_host = urlsplit(endpoint).netloc

    def expect(label, host, path, status, error=None, **kwargs):
        actual, value = request(endpoint, path, host, **kwargs)
        row = {"phase": receipt["phase"], "check": label, "host": host,
               "path": path, "expected_status": status, "status": actual}
        receipt["checks"].append(row)
        if actual != status:
            raise StepError(f"{label}: HTTP {actual}, expected {status}")
        if error is not None:
            row["expected_error"] = error
            if value != {"error": error}:
                raise StepError(label + ": wrong rejection reason")
        return value

    def live():
        if endpoint not in (read(ctx, STATUS, "textContent") or ""):
            raise StepError("Host settings changed the running listener address")
        # An existing event stream must answer after every save. Checking only
        # a green Running label or a new connection would miss a restart.
        socket.send({"type": "qa-host-policy-liveness"})
        if socket.receive("error")["code"] != "invalid_message":
            raise StepError("Existing mobile event stream did not survive config save")
        receipt["checks"].append({"phase": receipt["phase"], "check": "same-listener-and-event-socket-survive"})

    def exact_hosts():
        for host in HOSTS:
            value = expect("explicit-authority-allowed", host, "/api/v1/health", 200)
            if value.get("service") != "taomni-mobile":
                raise StepError("Allowed Host did not reach the actual mobile listener")
        expect("explicit-host-case-insensitive", HOSTS[0].upper(), "/api/v1/health", 200)
        expect("explicit-shell-allowed", HOSTS[0], "/", 200)
        for host in (ARBITRARY, "child." + HOSTS[0], HOSTS[0] + ".evil.invalid",
                     HOSTS[0] + ":18443", "qa-proxy-port.example.invalid",
                     "qa-proxy-port.example.invalid:18444"):
            expect("non-exact-authority-denied", host, "/api/v1/health", 403, "host_denied")
        expect("unlisted-shell-denied", ARBITRARY, "/", 403, "host_denied")

    def security(host, token):
        expect("missing-bearer-denied", host, "/api/v1/sessions", 401, "unauthorized", origin=ORIGIN)
        expect("invalid-bearer-denied", host, "/api/v1/sessions", 401, "unauthorized",
               token="intentionally-invalid-qa-token", origin=ORIGIN)
        expect("unpaired-origin-denied", host, "/api/v1/sessions", 403, "origin_denied",
               token=token, origin=UNPAIRED_ORIGIN)
        expect("same-origin-still-requires-bearer", host, "/api/v1/sessions", 401, "unauthorized",
               origin="http://" + host)
        value = expect("paired-origin-and-valid-bearer-allowed", host, "/api/v1/sessions", 200,
                       token=token, origin=ORIGIN)
        if not isinstance(value.get("sessions"), list) or not isinstance(value.get("saved_sessions"), list):
            raise StepError("Authorized response was not a mobile session list")
        expect("websocket-ticket-still-requires-bearer", host, "/api/v1/ws-ticket", 401,
               "unauthorized", body={}, origin=ORIGIN)
        expect("pairing-code-still-required", host, "/api/v1/pair", 400, "invalid_or_expired_code",
               body={"endpoint_label": "host-policy-negative", "pairing_code": "invalid-qa-code"}, origin=ORIGIN)

    try:
        if read(ctx, ALL, "checked") is not False or read(ctx, INPUT, "value") != "":
            raise StepError("Host-policy regression requires fresh restricted defaults")
        expect("default-loopback-allowed", loopback_host, "/api/v1/health", 200)
        expect("default-arbitrary-host-denied", ARBITRARY, "/api/v1/health", 403, "host_denied")
        expect("default-arbitrary-shell-denied", ARBITRARY, "/", 403, "host_denied")
        status, paired = request(endpoint, "/api/v1/pair", loopback_host, origin=ORIGIN,
                                 body={"endpoint_label": "host-policy-phone", "pairing_code": pairing_code})
        if (status != 200 or not isinstance(paired, dict) or not paired.get("device_id")
                or not isinstance(paired.get("token"), str) or not paired["token"]):
            raise StepError("Host-policy regression could not pair through the real listener")
        token = paired["token"]
        socket = Ws(endpoint, "/events", token, ORIGIN)
        if socket.receive("hello").get("device_id") != paired["device_id"]:
            raise StepError("Event socket does not belong to the paired device")
        security(loopback_host, token)

        receipt["phase"] = "explicit"
        save_hosts(ctx, allow_all=False, replace_hosts=True)
        live()
        exact_hosts()
        security(HOSTS[0], token)

        receipt["phase"] = "allow-all"
        save_hosts(ctx, allow_all=True)
        live()
        for host in (ARBITRARY, "child." + HOSTS[0], HOSTS[0] + ":18443"):
            expect("allow-all-arbitrary-authority-allowed", host, "/api/v1/health", 200)
        expect("allow-all-arbitrary-shell-allowed", ARBITRARY, "/", 200)
        security(ARBITRARY, token)

        receipt["phase"] = "restricted"
        save_hosts(ctx, allow_all=False)
        live()
        exact_hosts()
        security(HOSTS[0], token)
        receipt["passed"] = True
        return "Real HTTP Host policy, unchanged Origin/Bearer/pairing and live event socket passed"
    except Exception as error:
        receipt["failure_type"] = type(error).__name__
        raise
    finally:
        if socket is not None:
            with suppress(OSError, ValueError):
                socket.close()
        destination.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
