"""parity005_completion: controlled Java completion provider for ED-PARITY-005.

Browser-only fixture (design docs-feature/code-workspace-idea-parity/
java-basic-completion-plan.md#test-cases, fixture B-005 / M0). It installs two
localStorage payloads BEFORE the first navigation:

* `taomni.qa.workspaceSeed.v1`     - exact UTF-8 workspace bytes materialized
  into the preview VFS (src/stubs/localVfs.ts) so the case opens deterministic
  content through the real tree + editor.
* `taomni.qa.completionProvider.v1` - the scripted provider. The preview IPC
  stub (src/stubs/tauri-core.ts) answers lsp_completion /
  lsp_completion_resolve from it, so the real CodeMirror source, accept
  transaction, snippet session and undo history are exercised. It is a
  CONTROLLED provider: its candidates are not real Java semantics and no case
  may call them a real JDT LS answer.

A case may override the resolve behaviour mid-run with
`taomni.qa.completionProvider.fault.v1` (mode/delayMs/reason/message), which is
merged over the variant's own resolve config.

Exposes:
* ${fixture.parity005_root}       - preview workspace root ("/preview/parity005")
* ${fixture.parity005_file}       - Main.java absolute VFS path
* ${fixture.parity005_mid_file}   - MidWord.java (M0 mid-word) path
* ${fixture.parity005_empty_file} - EmptySnippet.java (empty placeholder) path
"""

from __future__ import annotations

import json
from typing import Any

PROVIDER_KEY = "taomni.qa.completionProvider.v1"
FAULT_KEY = "taomni.qa.completionProvider.fault.v1"
SEED_KEY = "taomni.qa.workspaceSeed.v1"

VFS_ROOT = "/preview"
ROOT = VFS_ROOT + "/parity005"

B1_MAIN = (
    "package parity005;\n"
    "\n"
    "public class Main {\n"
    "    void sample() {\n"
    "        Stri;\n"
    "    }\n"
    "}\n"
)

M0_MID = (
    "package parity005;\n"
    "\n"
    "public class Main {\n"
    "    void sample() {\n"
    "        StringUtiSuffix;\n"
    "    }\n"
    "}\n"
)

IMPORT_STRING_BUILDER = "import java.lang.StringBuilder;\n"
IMPORT_STRING_UTILS = "import org.apache.commons.lang3.StringUtils;\n"

PREFIX_RANGE = {
    "start": {"line": 4, "character": 8},
    "end": {"line": 4, "character": 12},
}


def _insert_import(new_text: str) -> dict[str, Any]:
    return {
        "newText": new_text,
        "range": {
            "start": {"line": 1, "character": 0},
            "end": {"line": 1, "character": 0},
        },
    }


STRING_BUILDER_ITEM = {
    "label": "StringBuilder",
    "kind": 7,
    "detail": "java.lang.StringBuilder",
    "documentation": "Controlled parity candidate (not a real Java analysis result).",
    "insertText": None,
    "insertTextFormat": 2,
    "filterText": None,
    "sortText": "0001",
    "textEdit": {
        "newText": "StringBuilder(${1:\"x\"}, ${2:1})$0",
        "range": PREFIX_RANGE,
    },
    "additionalTextEdits": [],
    "data": {"qaIdentity": "parity005-combined-1"},
}

STRING_BUFFER_ITEM = {
    "label": "StringBuffer",
    "kind": 7,
    "detail": "java.lang.StringBuffer",
    "documentation": "Second controlled candidate for up/down and mouse selection.",
    "insertText": "StringBuffer",
    "insertTextFormat": 1,
    "filterText": None,
    "sortText": "0002",
    "textEdit": {"newText": "StringBuffer", "range": PREFIX_RANGE},
    "additionalTextEdits": [],
    "data": {"qaIdentity": "parity005-decoy-2"},
}

STRING_UTILS_ITEM = {
    "label": "StringUtils",
    "kind": 7,
    "detail": "org.apache.commons.lang3.StringUtils",
    "documentation": "Third controlled candidate.",
    "insertText": "StringUtils",
    "insertTextFormat": 1,
    "filterText": None,
    "sortText": "0003",
    "textEdit": {"newText": "StringUtils", "range": PREFIX_RANGE},
    "additionalTextEdits": [],
    "data": {"qaIdentity": "parity005-third-3"},
}

EMPTY_SNIPPET_ITEM = {
    "label": "StringBuilder",
    "kind": 7,
    "detail": "java.lang.StringBuilder",
    "documentation": "Empty first placeholder variant.",
    "insertText": None,
    "insertTextFormat": 2,
    "filterText": None,
    "sortText": "0001",
    "textEdit": {
        "newText": "StringBuilder(${1:})$0",
        "range": PREFIX_RANGE,
    },
    "additionalTextEdits": [],
    "data": {"qaIdentity": "parity005-empty-placeholder"},
}

MID_WORD_ITEM = {
    "label": "StringUtils",
    "kind": 7,
    "detail": "org.apache.commons.lang3.StringUtils",
    "documentation": "Mid-word controlled candidate with both provider ranges.",
    "insertText": "StringUtils",
    "insertTextFormat": 1,
    "filterText": None,
    "sortText": "0001",
    "textEdit": {
        "newText": "StringUtils",
        "range": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 17}},
    },
    "insertReplaceEdit": {
        "newText": "StringUtils",
        "insert": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 17}},
        "replace": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 23}},
    },
    "additionalTextEdits": [],
    "data": {"qaIdentity": "parity005-mid-word"},
}


def provider_payload() -> dict[str, Any]:
    return {
        "variants": [
            {
                "files": ["/main.java"],
                "displayName": "Java (controlled parity provider)",
                "items": [STRING_BUILDER_ITEM, STRING_BUFFER_ITEM, STRING_UTILS_ITEM],
                # Only the target candidate resolves with the auto-import; the
                # decoy candidates must never borrow another item's edit.
                "resolve": {
                    "mode": "resolved",
                    "additionalTextEditsByLabel": {
                        "StringBuilder": [_insert_import(IMPORT_STRING_BUILDER)],
                    },
                },
            },
            {
                "files": ["/emptysnippet.java"],
                "displayName": "Java (controlled parity provider)",
                "items": [EMPTY_SNIPPET_ITEM],
                "resolve": {
                    "mode": "resolved",
                    "additionalTextEditsByLabel": {
                        "StringBuilder": [_insert_import(IMPORT_STRING_BUILDER)],
                    },
                },
            },
            {
                "files": ["/midword.java"],
                "displayName": "Java (controlled parity provider)",
                "items": [MID_WORD_ITEM],
                "resolve": {
                    "mode": "resolved",
                    "additionalTextEdits": [_insert_import(IMPORT_STRING_UTILS)],
                },
            },
        ],
    }


def seed_payload() -> dict[str, Any]:
    return {
        "files": {
            "parity005/Main.java": B1_MAIN,
            "parity005/MidWord.java": M0_MID,
            "parity005/EmptySnippet.java": B1_MAIN,
            "parity005/Other.java": B1_MAIN,
        }
    }


def _install(page: Any, key: str, value: Any) -> None:
    script = (
        "try { localStorage.setItem("
        + json.dumps(key)
        + ", "
        + json.dumps(json.dumps(value))
        + "); } catch (_) {}"
    )
    try:
        page.context.add_init_script(script)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    try:
        page.evaluate(script)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - about:blank has no storage origin
        pass


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    if ctx.cfg.get("app", {}).get("mode") != "browser":
        raise FixtureSkip("parity005_completion is a browser-mode controlled provider fixture")
    page = getattr(ctx, "page", None)
    if page is None:
        raise FixtureSkip("parity005_completion requires a browser page")

    _install(page, SEED_KEY, seed_payload())
    _install(page, PROVIDER_KEY, provider_payload())

    ctx.values["parity005_root"] = ROOT
    ctx.values["parity005_file"] = ROOT + "/Main.java"
    ctx.values["parity005_mid_file"] = ROOT + "/MidWord.java"
    ctx.values["parity005_empty_file"] = ROOT + "/EmptySnippet.java"
    ctx.values["parity005_uncovered_file"] = ROOT + "/Other.java"


def teardown(ctx: Any) -> None:
    # Per-case browser context owns its storage; clear defensively so a reused
    # context cannot leak the controlled provider into another case.
    page = getattr(ctx, "page", None)
    if page is None:
        return
    for key in (PROVIDER_KEY, FAULT_KEY, SEED_KEY):
        try:
            page.evaluate("try { localStorage.removeItem(" + json.dumps(key) + "); } catch (_) {}")
        except Exception:  # noqa: BLE001
            pass
    return None
