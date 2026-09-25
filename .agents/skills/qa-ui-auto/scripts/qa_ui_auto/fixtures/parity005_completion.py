"""ED-PARITY-005 Basic-Completion fixture: one deterministic mid-word candidate.

The card's acceptance question is what a Tab and an Enter do to a caret sitting
inside an identifier whose tail the provider never saw
(``StringUti|Suffix``). Proving it needs a provider answer that is fixed before
the run, not one read back from the app:

* Browser: the preview has no language server, so this fixture seeds the virtual
  local filesystem with the fixture document and arms the dev stub's QA
  completion surface (see ``src/stubs/tauri-core.ts``). The armed surface is
  inert unless the storage key below exists, so ordinary ``pnpm dev`` and every
  native build are unaffected.
* Native: the same document is materialised as an isolated Maven project beside
  the run report. It is never built or imported by the fixture; the provider
  identity (JDT LS, JDK, classpath) is recorded by the case, not assumed here.

Expected values are fixed constants shared with the cases; they are never
derived from an observed run.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

#: localStorage key the dev stub reads. Absent => no QA surface at all.
CONFIG_KEY = "taomni.qa.parity005Completion.v1"
#: Short override a case writes with `seed_storage` to walk the resolve fault
#: modes (null / failed / timeout / resolved) without reloading the page.
MODE_KEY = "taomni.qa.parity005CompletionMode.v1"

#: Provider item path relative to the fixture root.
FIXTURE_FILE = "parity005/Main.java"

#: Second file for the identity round: switching away and back must not leak a
#: candidate, a gate or a document between the two buffers.
OTHER_FILE = "parity005/Other.java"
OTHER_DOCUMENT = (
    "package parity005;\n"
    "\n"
    "public class Other {\n"
    "    void sample() {\n"
    "        int marker = 1;\n"
    "    }\n"
    "}\n"
)

#: B0/M0 body. The caret belongs after ``StringUti``, at line 4 character 17.
DOCUMENT = (
    "package parity005;\n"
    "\n"
    "public class Main {\n"
    "    void sample() {\n"
    "        StringUtiSuffix;\n"
    "    }\n"
    "}\n"
)

WORD = "StringUtiSuffix"
PREFIX = "StringUti"
IMPORT_LINE = "import org.apache.commons.lang3.StringUtils;"

INSERT_RANGE = {
    "start": {"line": 4, "character": 8},
    "end": {"line": 4, "character": 8 + len(PREFIX)},
}
REPLACE_RANGE = {
    "start": {"line": 4, "character": 8},
    "end": {"line": 4, "character": 8 + len(WORD)},
}

#: The initial item. It carries both provider ranges and no import: the import
#: only arrives through `completionItem/resolve`, which is what makes the D1
#: failure mode observable.
ITEM: dict[str, Any] = {
    "label": "StringUtils",
    "kind": 7,
    "detail": "org.apache.commons.lang3.StringUtils",
    "documentation": None,
    "insertText": "StringUtils",
    "insertTextFormat": 1,
    "filterText": None,
    "sortText": "0000001",
    "textEdit": {"range": INSERT_RANGE, "newText": "StringUtils"},
    "insertReplaceEdit": {
        "newText": "StringUtils",
        "insert": INSERT_RANGE,
        "replace": REPLACE_RANGE,
    },
    "additionalTextEdits": [],
    "raw": {"label": "StringUtils", "kind": 7},
}

#: What a successful resolve adds: the single lang3 import at line 1 column 0.
RESOLVED_ITEM: dict[str, Any] = {
    **ITEM,
    "additionalTextEdits": [
        {
            "range": {
                "start": {"line": 1, "character": 0},
                "end": {"line": 1, "character": 0},
            },
            "newText": f"{IMPORT_LINE}\n",
        },
    ],
}

POM_XML = """<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>parity005</groupId>
  <artifactId>completion</artifactId>
  <version>1.0</version>
  <properties>
    <maven.compiler.source>21</maven.compiler.source>
    <maven.compiler.target>21</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-lang3</artifactId>
      <version>3.12.0</version>
    </dependency>
  </dependencies>
</project>
"""


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _config(resolve_mode: str) -> dict[str, Any]:
    return {
        "filePath": FIXTURE_FILE,
        "item": ITEM,
        "resolvedItem": RESOLVED_ITEM,
        "resolveMode": resolve_mode,
    }


def _seed_browser(ctx: Any) -> None:
    """Seed the virtual workspace and arm the stub's QA completion surface."""
    page = ctx.page
    # Fixtures run before the case's first navigation, and IndexedDB is denied
    # on about:blank. Land on the app origin first; the case's own `open` step
    # reloads it, and both IndexedDB and localStorage survive that.
    base_url = ctx.cfg.get("app", {}).get("base_url") or ""
    current = getattr(page, "url", "") or ""
    if base_url and not current.startswith(base_url):
        page.goto(base_url, wait_until="domcontentloaded")
    page.evaluate(
        """async ([filePath, document, key, config, modeKey, otherPath, otherDocument]) => {
          // Directory chain first: the VFS refuses a file whose parent is missing.
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open("taomni-vfs", 1);
            // Mirror localVfs' upgrade so the seed works whether or not the
            // preview already created the store in this profile.
            req.onupgradeneeded = () => {
              const created = req.result;
              if (!created.objectStoreNames.contains("files")) {
                created.createObjectStore("files", { keyPath: "path" })
                  .createIndex("parent", "parent", { unique: false });
              }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const store = () => db.transaction("files", "readwrite").objectStore("files");
          const put = (record) => new Promise((resolve, reject) => {
            const req = store().put(record);
            req.onsuccess = () => resolve(undefined);
            req.onerror = () => reject(req.error);
          });
          const now = Math.floor(Date.now() / 1000);
          await put({ path: "/preview/parity005", parent: "/preview", name: "parity005",
                      type: "dir", size: 0, mtime: now });
          const encoded = new TextEncoder().encode(document);
          await put({ path: `/preview/${filePath}`, parent: "/preview/parity005",
                      name: "Main.java", type: "file", size: encoded.length,
                      mtime: now, data: encoded.buffer });
          const other = new TextEncoder().encode(otherDocument);
          await put({ path: `/preview/${otherPath}`, parent: "/preview/parity005",
                      name: "Other.java", type: "file", size: other.length,
                      mtime: now, data: other.buffer });
          localStorage.setItem(key, JSON.stringify(config));
          localStorage.removeItem(modeKey);
        }""",
        [FIXTURE_FILE, DOCUMENT, CONFIG_KEY, _config("resolved"), MODE_KEY,
         OTHER_FILE, OTHER_DOCUMENT],
    )


def _cleanup_browser(ctx: Any) -> None:
    try:
        ctx.page.evaluate(
            """async ([filePath, key, modeKey, otherPath]) => {
              localStorage.removeItem(key);
              localStorage.removeItem(modeKey);
              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open("taomni-vfs", 1);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });
              if (!db.objectStoreNames.contains("files")) return;
              const tx = db.transaction("files", "readwrite");
              const store = tx.objectStore("files");
              for (const path of [`/preview/${filePath}`, `/preview/${otherPath}`, "/preview/parity005"]) {
                await new Promise((resolve) => {
                  const req = store.delete(path);
                  req.onsuccess = () => resolve(undefined);
                  req.onerror = () => resolve(undefined);
                });
              }
            }""",
            [FIXTURE_FILE, CONFIG_KEY, MODE_KEY, OTHER_FILE],
        )
    except Exception as exc:  # noqa: BLE001 - cleanup must never mask the case result
        print(f"[parity005_completion] browser cleanup skipped: {exc}")


def _native_project_root(ctx: Any) -> Path:
    base = Path(ctx.report_root).resolve() / "parity005-native"
    base.mkdir(parents=True, exist_ok=True)
    root = base / "completion"
    (root / "src" / "main" / "java" / "parity005").mkdir(parents=True, exist_ok=True)
    (root / "pom.xml").write_bytes(POM_XML.encode("utf-8"))
    (root / "src" / "main" / "java" / "parity005" / "Main.java").write_bytes(
        DOCUMENT.encode("utf-8")
    )
    return root


def setup(ctx: Any) -> None:
    mode = ctx.cfg.get("app", {}).get("mode")
    ctx.values["parity005_document_sha256"] = sha256_text(DOCUMENT)
    ctx.values["parity005_config_sha256"] = sha256_text(
        json.dumps(_config("resolved"), sort_keys=True)
    )
    ctx.values["parity005_word"] = WORD
    ctx.values["parity005_import"] = IMPORT_LINE

    if mode == "browser":
        _seed_browser(ctx)
        return

    root = _native_project_root(ctx)
    ctx.values["parity005_project_root"] = root.as_posix()
    ctx.values["parity005_main_java_sha256"] = sha256_text(DOCUMENT)


def teardown(ctx: Any) -> None:
    if ctx.cfg.get("app", {}).get("mode") == "browser":
        _cleanup_browser(ctx)
