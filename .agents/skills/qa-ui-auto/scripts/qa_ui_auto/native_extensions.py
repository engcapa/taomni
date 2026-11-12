"""Leaf-module registrations; implementations never import the dispatch facade.

Keep feature extensions out of the oversized legacy native_steps owner. Existing
verb names, callables, state and cleanup stay with their original modules.
"""
from __future__ import annotations

from typing import Any, Callable

NativeVerb = Callable[[Any, Any], str]
RegisterVerb = Callable[[str], Callable[[NativeVerb], NativeVerb]]


def register(register_verb: RegisterVerb, verbs: dict[str, NativeVerb]) -> None:
    from .native_editor_probes import register as editor_probes
    from .terminal_rendering_probe import register_native as terminal_rendering
    from .mobile_native import register as mobile
    from .os_file_drag import native as os_file_drag
    from .workspace_drop_observation import native as assert_workspace_drop_import

    editor_probes(register_verb)
    terminal_rendering(verbs)
    mobile(register_verb, verbs["terminal_input"])
    register_verb("os_file_drag")(os_file_drag)
    register_verb("assert_workspace_drop_import")(assert_workspace_drop_import)
