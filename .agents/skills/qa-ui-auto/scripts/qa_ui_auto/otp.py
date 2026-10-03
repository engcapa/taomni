"""Independent RFC 4226 / RFC 6238 oracle for the MFA authenticator cases.

The app generates codes in Rust (desktop) or WebCrypto (browser stub); this
module recomputes them from the case's own secret so an assertion never
trusts the product's arithmetic.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time

ALGORITHMS = {"SHA1": hashlib.sha1, "SHA256": hashlib.sha256, "SHA512": hashlib.sha512}
# A code read just after a window rolled over may still show the previous
# window until the app's next refresh tick (<= 1.5 s in the panel).
ROLLOVER_GRACE_SEC = 5.0


def decode_base32(secret: str) -> bytes:
    """Decode a Base32 secret the way authenticator apps accept it."""
    cleaned = re.sub(r"[\s-]", "", secret).upper().rstrip("=")
    if not cleaned or re.fullmatch(r"[A-Z2-7]+", cleaned) is None:
        raise ValueError("secret is not Base32")
    return base64.b32decode(cleaned + "=" * (-len(cleaned) % 8))


def hotp(key: bytes, counter: int, digits: int = 6, algorithm: str = "SHA1") -> str:
    digest = hmac.new(key, counter.to_bytes(8, "big"), ALGORITHMS[algorithm]).digest()
    offset = digest[-1] & 0x0F
    value = int.from_bytes(digest[offset:offset + 4], "big") & 0x7FFFFFFF
    return str(value % 10 ** digits).zfill(digits)


def totp_candidates(secret: str, *, period: int = 30, digits: int = 6, algorithm: str = "SHA1",
                    now: float | None = None) -> dict[int, str]:
    """Codes a correct display may show at `now`, keyed by time step."""
    if algorithm not in ALGORITHMS:
        raise ValueError(f"unsupported algorithm {algorithm!r}")
    if not 6 <= digits <= 8 or period <= 0:
        raise ValueError("digits must be 6..8 and period positive")
    key = decode_base32(secret)
    moment = time.time() if now is None else now
    step = int(moment // period)
    steps = [step]
    if step > 0 and moment - step * period < ROLLOVER_GRACE_SEC:
        steps.insert(0, step - 1)
    return {s: hotp(key, s, digits, algorithm) for s in steps}
