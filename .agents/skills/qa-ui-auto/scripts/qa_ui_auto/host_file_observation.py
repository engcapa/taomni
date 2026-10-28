"""Observe complete host bytes and promptly release readers between hash polls."""

from contextlib import contextmanager
import hashlib
from pathlib import Path
import re

from .deadline import budget_time as time
from .steps import StepError


@contextmanager
def open_observation(path: Path):
    # Windows MoveFileEx replacement can deny an open target even with DELETE
    # sharing. Release this complete snapshot before the next poll; native
    # publication owns its bounded retry, rather than relying on reader flags.
    with path.open("rb") as stream:
        yield stream


def assert_file_sha256(_ctx, args):
    if not isinstance(args, dict) or not {"path", "equals"} <= set(args):
        raise StepError("assert_file_sha256: expected {path, equals, timeout_sec?}")
    path = Path(str(args["path"])).expanduser()
    expected = str(args["equals"]).lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise StepError("assert_file_sha256: equals must be a lowercase SHA-256 hex digest")
    timeout = float(args.get("timeout_sec", 10))
    deadline = time.time() + timeout
    actual = "missing"
    while time.time() < deadline:
        try:
            with open_observation(path) as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual == expected:
                return f"host byte SHA-256 verified: {actual}"
        except FileNotFoundError:
            actual = "missing"
        time.sleep(0.25)
    raise StepError(
        f"assert_file_sha256: {path} hash {actual!r} != {expected!r} after {timeout}s"
    )
