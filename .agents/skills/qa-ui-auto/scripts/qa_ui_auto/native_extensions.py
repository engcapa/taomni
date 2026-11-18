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
    from .file_clipboard import native as file_clipboard
    from .system_file_paste import run as system_file_paste
    register_verb("file_clipboard")(file_clipboard)
    register_verb("system_file_paste")(system_file_paste)
    from .explorer_observation import native as assert_explorer_files
    register_verb("assert_explorer_files")(assert_explorer_files)
    from .file_open_observation import native as assert_file_open_bytes
    register_verb("assert_file_open_bytes")(assert_file_open_bytes)
    from .file_dialog import run as native_file_dialog
    from .native_paste import run as native_paste
    from .export_quality import native as assert_export_quality
    register_verb("assert_export_quality")(assert_export_quality)
    from .drawio_roundtrip import assert_preview, assert_export
    register_verb("assert_drawio_preview")(assert_preview)
    register_verb("assert_drawio_roundtrip")(assert_export)
    from .control_wheel import native as control_wheel
    register_verb("control_wheel")(control_wheel)
    from .markdown_export_observation import run as assert_markdown_artifact
    from .terminal_file_link import native as terminal_file_link
    from .html_preview_observation import native_click, native_observe
    register_verb("native_file_dialog")(native_file_dialog)
    register_verb("native_paste")(native_paste)
    register_verb("assert_markdown_artifact")(assert_markdown_artifact)
    register_verb("terminal_file_link")(terminal_file_link)
    register_verb("html_preview_click")(native_click)
    register_verb("assert_html_network")(native_observe)
    from .explorer_preview_visibility import native as show_explorer_preview
    register_verb("show_explorer_preview")(show_explorer_preview)
    from .viewer_raster import native as viewer_raster
    register_verb("viewer_raster")(viewer_raster)
    from .tao_provider_observation import observe as observe_tao_provider, assert_outcome
    register_verb("observe_tao_provider")(observe_tao_provider)
    register_verb("assert_tao_provider_outcome")(assert_outcome)
    from .tao_real_scenarios import run as tao_real_provider_scenarios
    register_verb("tao_real_provider_scenarios")(tao_real_provider_scenarios)
    from .tao_real_documents import run as tao_real_provider_documents
    register_verb("tao_real_provider_documents")(tao_real_provider_documents)
    from .tao_real_expanded import run as tao_real_provider_expanded
    register_verb("tao_real_provider_expanded")(tao_real_provider_expanded)
