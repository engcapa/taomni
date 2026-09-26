"""parity005_completion: controlled Java Basic Completion provider (browser).

ED-PARITY-005 browser fixture. It installs window.__taomniQaCompletion as an
init script before the app boots, so every browser case drives the real
CodeWorkspaceTab / workspace tree / completion source / accept transaction /
resolve gate against a provider whose exact item bytes the fixture declares.

Boundary (do not over-claim): this is a mocked IPC provider. It proves renderer
behaviour, range intent, atomic acceptance and the resolve gate. It cannot prove
real JDT LS candidates, Rust completionItem/resolve typing or host file bytes;
those stay in the native/provider case TC-IDE-PARITY-005-05.

The overlay also serves the workspace tree and file reads/writes for one root
(/preview/parity005) through the dev-server stub, so cases never depend on
IndexedDB state. Every file/byte/hash used here is recorded in
parity005-completion-manifest.json under the case directory.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = "/preview/parity005"
WORKSPACE_ID = "qa-parity005"
WORKSPACE_NAME = "parity005"
IMPORT_STRING_BUILDER = "import java.lang.StringBuilder;\n"
IMPORT_STRING_UTILS = "import org.apache.commons.lang3.StringUtils;\n"

POM = """<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>parity005</groupId>
  <artifactId>completion</artifactId>
  <version>1.0</version>
  <properties>
    <maven.compiler.source>21</maven.compiler.source>
    <maven.compiler.target>21</maven.compiler.target>
  </properties>
</project>
"""


def _body(line5: str) -> str:
    return (
        "package parity005;\n"
        "\n"
        "public class Main {\n"
        "    void sample() {\n"
        + line5 + "\n"
        "    }\n"
        "}\n"
    )


# B-005: prefix "Stri" at 0-based (4,8)..(4,12).
MAIN = _body("        Stri;")
# M0: caret after "StringUti" at (4,17); suffix "Suffix" ends at (4,23).
MID_WORD = _body("        StringUtiSuffix;")
# Same layout, plain TextEdit only (Tab may widen the insert range).
PLAIN_RANGE = _body("        StringUtiSuffix;")
# Inside a string literal: Tab must not guess a wider range.
STRING_LITERAL = (
    "package parity005;\n"
    "\n"
    "public class Main {\n"
    '    String s = "StringUtiSuffix";\n'
    "}\n"
)
# Empty first placeholder variant.
EMPTY_SNIPPET = _body("        Stri;")

_IMPORT_EDIT = {
    "range": {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 0}},
    "newText": IMPORT_STRING_BUILDER,
}

STRING_BUILDER_FULL = {
    "label": "StringBuilder",
    "kind": 7,
    "detail": "java.lang.StringBuilder",
    "documentation": "A mutable sequence of characters.",
    "sortText": "0001",
    "insertTextFormat": 1,
    "textEdit": {
        "range": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 12}},
        "newText": "StringBuilder",
    },
    "additionalTextEdits": [_IMPORT_EDIT],
    "raw": {"label": "StringBuilder", "data": "parity005-combined-1"},
}

STRING_BUILDER_PLAIN = {**STRING_BUILDER_FULL, "additionalTextEdits": []}

STRING_UTILS_DUAL = {
    "label": "StringUtils",
    "kind": 7,
    "detail": "org.apache.commons.lang3.StringUtils",
    "documentation": "Operations on String that are null safe.",
    "sortText": "0001",
    "insertTextFormat": 1,
    "textEdit": {
        "range": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 17}},
        "newText": "StringUtils",
    },
    "insertReplaceEdit": {
        "newText": "StringUtils",
        "insert": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 17}},
        "replace": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 23}},
    },
    "additionalTextEdits": [
        {
            "range": {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 0}},
            "newText": IMPORT_STRING_UTILS,
        }
    ],
    "raw": {"label": "StringUtils", "data": "parity005-utils-1"},
}

STRING_UTILS_PLAIN_RANGE = {**STRING_UTILS_DUAL, "insertReplaceEdit": None}

STRING_UTILS_BAD_RANGES = {
    **STRING_UTILS_DUAL,
    "insertReplaceEdit": {
        "newText": "StringUtils",
        "insert": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 17}},
        # Same newText but a different start: contradictory, the whole
        # acceptance must be rejected instead of half-applied.
        "replace": {"start": {"line": 4, "character": 10}, "end": {"line": 4, "character": 23}},
    },
}

EMPTY_PLACEHOLDER_ITEM = {
    "label": "StringBuilder",
    "kind": 7,
    "detail": "java.lang.StringBuilder",
    "documentation": "A mutable sequence of characters.",
    "sortText": "0001",
    "insertTextFormat": 2,
    "textEdit": {
        "range": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 12}},
        "newText": "StringBuilder(${1:})$0",
    },
    "additionalTextEdits": [_IMPORT_EDIT],
    "raw": {"label": "StringBuilder", "data": "parity005-empty-1"},
}

SNIPPET_TWO_FIELDS = {
    "label": "StringBuilder",
    "kind": 7,
    "detail": "java.lang.StringBuilder",
    "documentation": "A mutable sequence of characters.",
    "sortText": "0001",
    "insertTextFormat": 2,
    "textEdit": {
        "range": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 12}},
        "newText": 'StringBuilder(${1:"x"}, ${2:1})$0',
    },
    "additionalTextEdits": [_IMPORT_EDIT],
    "raw": {"label": "StringBuilder", "data": "parity005-combined-1"},
}

OVERLAP_RESOLVE_ITEM = {
    "label": "StringBuilder",
    "kind": 7,
    "detail": "java.lang.StringBuilder",
    "documentation": "A mutable sequence of characters.",
    "sortText": "0001",
    "insertTextFormat": 1,
    "textEdit": {
        "range": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 12}},
        "newText": "StringBuilder",
    },
    "additionalTextEdits": [
        # Overlaps the primary span: the whole acceptance must be rejected.
        {
            "range": {"start": {"line": 4, "character": 10}, "end": {"line": 4, "character": 12}},
            "newText": "import java.lang.StringBuilder;\n",
        }
    ],
    "raw": {"label": "StringBuilder", "data": "parity005-overlap-1"},
}


def _gate_item(name: str) -> dict:
    """A raw item WITHOUT additional edits: acceptance must resolve first.

    The label matches the fixture prefix on purpose so the candidate survives
    the popup's client-side filter; the name only makes the raw identity unique
    per file.
    """
    return {
        "label": "StringBuilder",
        "kind": 7,
        "detail": "java.lang.StringBuilder",
        "documentation": "A mutable sequence of characters.",
        "sortText": "0001",
        "insertTextFormat": 1,
        "textEdit": {
            "range": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 12}},
            "newText": "StringBuilder",
        },
        "additionalTextEdits": [],
        "raw": {"label": "StringBuilder", "data": "parity005-gate-" + name},
    }


def _resolved(primary: dict) -> dict:
    """The same item plus the import the provider only sends on resolve."""
    return {**primary, "additionalTextEdits": [_IMPORT_EDIT]}


def _string_lit_item() -> dict:
    return {
        **STRING_UTILS_PLAIN_RANGE,
        "textEdit": {
            "range": {"start": {"line": 3, "character": 16}, "end": {"line": 3, "character": 25}},
            "newText": "StringUtils",
        },
        "additionalTextEdits": [],
    }


def _files() -> list:
    return [
        {"path": "pom.xml", "text": POM},
        {
            "path": "Main.java",
            "text": MAIN,
            # Three distinct candidates: Up/Down/mouse selection identity.
            "items": [
                SNIPPET_TWO_FIELDS,
                {
                    "label": "StringBuffer",
                    "kind": 7,
                    "detail": "java.lang.StringBuffer",
                    "documentation": "A thread-safe mutable sequence of characters.",
                    "sortText": "0002",
                    "insertTextFormat": 1,
                    "textEdit": {
                        "range": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 12}},
                        "newText": "StringBuffer",
                    },
                    "additionalTextEdits": [
                        {
                            "range": {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 0}},
                            "newText": "import java.lang.StringBuffer;\n",
                        }
                    ],
                    "raw": {"label": "StringBuffer", "data": "parity005-alt-1"},
                },
                {
                    "label": "StringUtils",
                    "kind": 7,
                    "detail": "org.apache.commons.lang3.StringUtils",
                    "documentation": "Operations on String that are null safe.",
                    "sortText": "0003",
                    "insertTextFormat": 1,
                    "textEdit": {
                        "range": {"start": {"line": 4, "character": 8}, "end": {"line": 4, "character": 12}},
                        "newText": "StringUtils",
                    },
                    "additionalTextEdits": [
                        {
                            "range": {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 0}},
                            "newText": IMPORT_STRING_UTILS,
                        }
                    ],
                    "raw": {"label": "StringUtils", "data": "parity005-alt-2"},
                },
            ],
            "resolveQueue": [{"mode": "ok", "item": STRING_BUILDER_FULL}],
        },
        {
            "path": "MidWord.java",
            "text": MID_WORD,
            "items": [STRING_UTILS_DUAL],
            "resolveQueue": [{"mode": "ok", "item": STRING_UTILS_DUAL}],
        },
        {
            "path": "PlainRange.java",
            "text": PLAIN_RANGE,
            "items": [STRING_UTILS_PLAIN_RANGE],
            "resolveQueue": [{"mode": "ok", "item": STRING_UTILS_PLAIN_RANGE}],
        },
        {
            "path": "StringLit.java",
            "text": STRING_LITERAL,
            "items": [_string_lit_item()],
            "resolveQueue": [{"mode": "ok", "item": _string_lit_item()}],
        },
        {
            "path": "BadRange.java",
            "text": MID_WORD,
            "items": [STRING_UTILS_BAD_RANGES],
            "resolveQueue": [{"mode": "ok", "item": STRING_UTILS_BAD_RANGES}],
        },
        {
            "path": "EmptySnippet.java",
            "text": EMPTY_SNIPPET,
            "items": [EMPTY_PLACEHOLDER_ITEM],
            "resolveQueue": [{"mode": "ok", "item": EMPTY_PLACEHOLDER_ITEM}],
        },
        {
            "path": "GateNull.java",
            "text": MAIN,
            "items": [_gate_item("GateNull")],
            "resolveQueue": [
                {"mode": "null"},
                {"mode": "ok", "item": _resolved(_gate_item("GateNull"))},
            ],
        },
        {
            "path": "GateError.java",
            "text": MAIN,
            "items": [_gate_item("GateError")],
            "resolveQueue": [
                {"mode": "error"},
                {"mode": "error"},
                {"mode": "ok", "item": _resolved(_gate_item("GateError"))},
            ],
        },
        {
            "path": "GateTimeout.java",
            "text": MAIN,
            "items": [_gate_item("GateTimeout")],
            "resolveQueue": [
                {"mode": "timeout"},
                # Retry stays in flight long enough to observe the disabled
                # buttons, but below the renderer's 3s resolve watchdog so the
                # fresh resolve can still land.
                {"mode": "hold", "delayMs": 1500, "item": _resolved(_gate_item("GateTimeout"))},
            ],
        },
        {
            "path": "GateDismiss.java",
            "text": MAIN,
            "items": [_gate_item("GateDismiss")],
            "resolveQueue": [{"mode": "null"}],
        },
        {
            "path": "GateOverlap.java",
            "text": MAIN,
            "items": [_gate_item("GateOverlap")],
            "resolveQueue": [{"mode": "ok", "item": OVERLAP_RESOLVE_ITEM}],
        },
        {
            "path": "PendingFetch.java",
            "text": MAIN,
            "items": [STRING_BUILDER_FULL],
            "fetchDelayMs": 2500,
            "resolveQueue": [{"mode": "ok", "item": STRING_BUILDER_FULL}],
        },
        {
            "path": "PendingAccept.java",
            "text": MAIN,
            "items": [STRING_BUILDER_PLAIN],
            "resolveQueue": [{"mode": "hold", "delayMs": 2500, "item": STRING_BUILDER_FULL}],
        },
        {
            "path": "Other.java",
            "text": _body("        Object other = null;"),
            "items": [],
            "resolveQueue": [{"mode": "null"}],
        },
    ]


def _recent_workspaces() -> str:
    return json.dumps([
        {
            "id": WORKSPACE_ID,
            "name": WORKSPACE_NAME,
            "roots": [
                {
                    "id": WORKSPACE_NAME,
                    "name": WORKSPACE_NAME,
                    "path": WORKSPACE_ROOT,
                    "kind": "folder",
                }
            ],
            "looseFiles": [],
            "lastActiveFile": {
                "kind": "root",
                "rootId": WORKSPACE_NAME,
                "path": "Main.java",
            },
            "lastOpenedAt": 1756100000000,
            "isGitRepo": False,
        }
    ])


def _script() -> str:
    config = {
        "enabled": True,
        "workspaceRoot": WORKSPACE_ROOT,
        "files": _files(),
        "requests": 0,
        "resolves": 0,
        "releaseHolds": 0,
        "activeFile": None,
    }
    return (
        "(() => {"
        "globalThis.__taomniQaCompletion = " + json.dumps(config) + ";"
        "try {"
        "localStorage.setItem('taomni.recentWorkspaces.v1', "
        + json.dumps(_recent_workspaces()) + ");"
        "} catch (_) {}"
        "})();"
    )


def setup(ctx: Any) -> None:
    from . import FixtureSkip  # lazy: avoid package-init circular import

    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    if mode != "browser":
        raise FixtureSkip(
            "parity005_completion is a browser IPC mock; native cases use the real "
            "JDT LS fixtures (java_sample_projects + jdtls_required)"
        )
    page = getattr(ctx, "page", None)
    if page is None:
        raise FixtureSkip("parity005_completion requires a browser page")
    page.context.add_init_script(_script())  # type: ignore[attr-defined]

    case_dir = Path(getattr(ctx, "case_dir", "."))
    case_dir.mkdir(parents=True, exist_ok=True)
    files = _files()
    manifest = {
        "fixture": "parity005_completion",
        "mode": "browser",
        "workspaceRoot": WORKSPACE_ROOT,
        "provider": "controlled parity provider (dev-server IPC mock)",
        "boundary": "renderer behaviour only; not real JDT LS semantics",
        "files": [
            {
                "path": f["path"],
                "sha256": hashlib.sha256(f["text"].encode("utf-8")).hexdigest(),
                "bytes": len(f["text"].encode("utf-8")),
                "eol": "LF",
                "bom": False,
                "items": [item["label"] for item in f.get("items", [])],
                "resolveQueue": [step.get("mode") for step in f.get("resolveQueue", [])],
                "fetchDelayMs": f.get("fetchDelayMs", 0),
            }
            for f in files
        ],
    }
    (case_dir / "parity005-completion-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8",
    )


def teardown(ctx: Any) -> None:
    return None
