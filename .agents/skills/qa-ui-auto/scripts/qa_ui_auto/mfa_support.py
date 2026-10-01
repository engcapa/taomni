"""Shared helpers for the MFA authenticator verbs (browser and native).

See docs-feature/mfa-authenticator-design.md (TASK-08). Fixture images live
under qa-ui-auto-tests/synthetic-fixtures/mfa/ and are resolved from the
repository root (the runner's working directory).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from .deadline import budget_time as time
from .otp import ALGORITHMS, decode_base32, totp_candidates
from .steps import StepError

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_fixture(path: Any, verb: str) -> tuple[Path, bytes]:
    """Read a PNG fixture; relative paths resolve from the repository root."""
    if not isinstance(path, str) or not path:
        raise StepError(f"{verb}: expected a PNG fixture path")
    target = Path(path)
    if not target.is_absolute():
        target = Path.cwd() / target
    try:
        data = target.read_bytes()
    except OSError as exc:
        raise StepError(f"{verb}: cannot read {path}: {exc}") from exc
    if not data.startswith(PNG_SIGNATURE):
        raise StepError(f"{verb}: {path} is not a PNG file")
    return target, data


def totp_args(args: Any) -> dict[str, Any]:
    if not isinstance(args, dict) or not isinstance(args.get("selector"), str) or not isinstance(args.get("secret"), str):
        raise StepError("assert_totp_code: expected {selector, secret, period?, digits?, algorithm?, attribute?}")
    parsed = {
        "selector": args["selector"],
        "secret": args["secret"],
        "period": int(args.get("period", 30)),
        "digits": int(args.get("digits", 6)),
        "algorithm": str(args.get("algorithm", "SHA1")).upper(),
        "attribute": str(args.get("attribute", "data-code")),
        "timeout_sec": float(args.get("timeout_sec", 10)),
    }
    if parsed["algorithm"] not in ALGORITHMS:
        raise StepError(f"assert_totp_code: unsupported algorithm {parsed['algorithm']}")
    try:
        # Same minimum as the app (10 bytes = 16 Base32 characters).
        if len(decode_base32(parsed["secret"])) < 10:
            raise ValueError("secret is shorter than 16 Base32 characters")
        totp_candidates(parsed["secret"], period=parsed["period"], digits=parsed["digits"],
                        algorithm=parsed["algorithm"], now=0)
    except ValueError as exc:
        raise StepError(f"assert_totp_code: {exc}") from exc
    return parsed


def assert_totp_code(read: Callable[[str], Any], args: Any) -> str:
    """Poll one element's code attribute against an independent RFC 6238 oracle.

    `read` evaluates a read-only JavaScript expression in the app document. The
    selector must match exactly one element so a stale duplicate row cannot pass.
    """
    spec = totp_args(args)
    expression = (
        f"Array.from(document.querySelectorAll({json.dumps(spec['selector'])}), "
        f"e => e.getAttribute({json.dumps(spec['attribute'])}))"
    )
    expires = time.monotonic() + spec["timeout_sec"]
    observed: Any = None
    expected: dict[int, str] = {}
    while time.monotonic() < expires:
        observed = read(expression)
        expected = totp_candidates(spec["secret"], period=spec["period"], digits=spec["digits"],
                                   algorithm=spec["algorithm"], now=time.time())
        if isinstance(observed, list) and len(observed) == 1 and observed[0] in expected.values():
            step = next(s for s, code in expected.items() if code == observed[0])
            return f"TOTP matched RFC 6238 step {step}: {spec['selector']}"
        time.sleep(0.2)
    raise StepError(
        f"assert_totp_code: {spec['selector']} showed {observed!r}; RFC 6238 expects one of {expected}"
    )
