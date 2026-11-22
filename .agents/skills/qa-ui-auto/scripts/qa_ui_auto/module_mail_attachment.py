"""Observe the account's cache file and the IMAP server's attachment reads."""
import hashlib

from . import mail_fake_server
from .module_retained_observation import ordinary
from .steps import StepError


def observe(data, legacy, values, previous):
    expected = values["file_open_mail_text"].encode()
    files = list((data / "attachments").glob("*/*/*.bin"))
    if len(files) != 1 or list((legacy / "attachments").glob("*/*/*.bin")):
        raise StepError("Expected one cached attachment under the module and none in the legacy cache")
    part = files[0]
    ordinary(part)
    if part.parent.name != "INBOX" or part.read_bytes() != expected:
        raise StepError("The module attachment differs from the opened INBOX fixture")
    uid = int(part.name.split("-", 1)[0])
    server = mail_fake_server.ACTIVE.state
    with server.lock:
        reads = [event["command"] for event in server.fetch_events if event["folder"] == "INBOX"
                 and event["command"].upper().startswith(f"UID FETCH {uid} ")
                 and "BODY.PEEK[" in event["command"].upper() and "[HEADER" not in event["command"].upper()]
    if not reads:
        raise StepError("No IMAP message or attachment body was read")
    current = {"path": part.relative_to(data).as_posix(), "sha256": hashlib.sha256(expected).hexdigest(),
               "bodyFetches": reads}
    if previous and previous != current:
        raise StepError("Reopening the cached attachment changed its bytes, path, or IMAP body fetch count")
    return current
