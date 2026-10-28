"""Register native editor lifecycle probes without coupling them to dispatch internals."""
from pathlib import Path
from typing import Any, Callable, Protocol

from . import save_race
from .steps import StepError


class EditorProbeContext(Protocol):
    session: Any
    case_dir: Path


Probe = Callable[[EditorProbeContext, Any], str]
Register = Callable[[str], Callable[[Probe], Probe]]


def observe_language(ctx: EditorProbeContext, args: Any) -> str:
    if args is not None:
        raise StepError("observe_language_startup does not accept arguments")
    from .language_startup_observer import install_native
    return install_native(ctx)


def assert_language(ctx: EditorProbeContext, args: Any) -> str:
    from .language_startup_observer import assert_native
    return assert_native(ctx, args)


def register(register_verb: Register) -> None:
    from .sdk_startup_probe import run as sdk_startup
    # The existing QA-only save-race owner keeps its state and side effects.
    # Registration moves here with no changes to those public verbs or payloads.
    for name, action in {
        "save_race_arm": save_race.arm,
        "save_race_wait_entered": save_race.wait_entered,
        "save_race_release": save_race.release,
        "save_race_trace": save_race.trace,
        "save_race_note": save_race.note,
        "observe_language_startup": observe_language,
        "assert_language_startup": assert_language,
        "native_sdk_startup_probe": sdk_startup,
    }.items():
        register_verb(name)(action)
