# Taomni Notepad Technical Spikes (S-1 ~ S-6)

Date: 2026-11-21
Status: Completed (all 6 spikes verified against current `main` baseline)

## S-1: `documentStore` Support for Untitled Documents (`untitled:<uuid>`) & Re-keying

- **Conclusion**: **Feasible with minimal, backward-compatible extension.**
- **Analysis**:
  - `src/lib/openFile/pathIdentity.ts` normalizes disk paths via `documentPathKey(path)`. Returning `untitled:*` keys verbatim preserves identity across Windows/macOS/Linux without stripping prefixes or altering any path caller.
  - `src/stores/documentStore.ts` holds `documents: Record<string, ViewerDocument>`. When `isUntitledKey(path)` is true:
    - `open(path)` creates/keeps an in-memory `ViewerDocument` without calling `viewerStat` or `viewerReadText`.
    - `checkExternal(path)` and `reload(path)` safely no-op.
    - `createUntitled(docId, options)` initializes `savedHash: ""`, `savedContent: ""`, `dirty: false` (or `true` when seeded).
    - `rekey(oldKey, newPath, ack, options)` atomically moves the document entry from `oldKey` (`untitled:...` or old path) to `documentPathKey(newPath)` on Save As / Rename, updating `key`, `path`, `kind`, `savedHash`, `savedContent`, `mtime`, `size`, `readOnly: false`, `readOnlyReason: undefined`, and flushing drafts/backups cleanly.
- **Design Impact**: Satisfies AC-01, DEC-13 without creating a second document repository.

## S-2: In-Tab Dual CodeMirror 6 Views Sharing Buffer & Undo Stack

- **Conclusion**: **Feasible via synchronized transaction & shared history bridge (`createSplitBridge`).**
- **Analysis**:
  - Each CM6 `EditorView` owns its own `EditorState` (allowing independent selection, scroll position, and cursor per pane), while `documentStore` holds the authoritative text buffer (`content`).
  - Rather than trying to share one mutable `EditorState` instance across two `EditorView`s (which CM6 discourages because selection and viewport effects belong to `EditorState`), we synchronize user `docChanged` transactions between pane 0 and pane 1 with a transaction annotation (`splitSyncOrigin`) so the peer pane applies the exact minimal `ChangeSet` without resetting scroll or selection outside the changed span, and undo/redo commands dispatch through a unified coordinator (`runUndo` / `runRedo`) or keep both views' `@codemirror/commands` history mirrored synchronously.
  - Both panes also display identical bookmark/mark/change-history decorations driven from `notepadStore` + `documentStore`.
- **Design Impact**: Satisfies AC-33 & DEC-22 without mutating `tabsSlice` or creating duplicate `ViewerDocument` instances.

## S-3: Document Map (Minimap) Rendering & Performance

- **Conclusion**: **Feasible via throttled HTML5 Canvas + viewport overlay.**
- **Analysis**:
  - Render text lines onto a `<canvas>` in `DocumentMapPanel` (132px default dock width) using theme CSS variables (`--muted` for line strokes, `--accent-s` for visible viewport box, `--warn`/`--ok` for bookmarks/matches).
  - Throttle redraws with `requestAnimationFrame` on document edits and pane scroll events.
  - For documents exceeding 10,000 lines, sample lines proportionally to canvas pixel height (`step = Math.ceil(lines.length / canvasHeight)`) so draw time remains < 4 ms even for 5 MB / 100k-line files.
  - Clicking or dragging on the canvas smoothly scrolls the active pane's `.cm-scroller`.
- **Design Impact**: Satisfies AC-36 & F-63 with bounded frame cost.

## S-4: Large File Tiers (5 MB / 5–20 MB / >20 MB / 50 MB Evaluation)

- **Conclusion**: **Retain 5 MB editable / 5–20 MB chunked read-only + restricted edit / >20 MB rejection in P0; 50 MB deferred.**
- **Analysis**:
  - `src/lib/viewer.ts` and `src-tauri/src/viewer/mod.rs` already enforce `DEFAULT_TEXT_BYTES = 5 MiB`, `HARD_TEXT_BYTES = 20 MiB`, and `VIEWER_TEXT_CHUNK_SIZE = 256 KiB`.
  - Files in `(5 MiB, 20 MiB]` open in chunked read-only mode (`document.large === true`) with Previous/Next Chunk controls and an explicit "Open for editing anyway" confirmation (`forceEdit = true`).
  - When a `(5 MiB, 20 MiB]` file is confirmed for restricted editing (`!document.large && document.size > VIEWER_TEXT_EDIT_LIMIT`), Notepad automatically disables Change History LCS diffing, incremental jump-on-type, and periodic auto-backup (degrading to explicit save / save-on-backup) with a visible banner (`AC-13`).
  - Opening 50 MB in CM6 + JS string normalization consumes >300 MB peak heap and increases LCS/regex latency beyond interactive budgets; therefore 50 MB remains out of P0 scope per DEC-12.

## S-5: Three-Platform Single-Target Elevated Save

- **Conclusion**: **Feasible via staged private temporary file + strict single-target elevation copy.**
- **Analysis**:
  - `viewer_write_text_elevated(path, content, encoding, bom, eol)` validates `path` is an existing absolute regular file (not an owned temporary copy, within 20 MiB), normalizes EOL and encodes bytes in Rust.
  - Encoded bytes are written to a unique private temporary file (`0o600` on Unix) cleaned up unconditionally via a RAII `Drop` guard.
  - Elevation copies **only** that staged temporary file to the canonical validated target path:
    - **Windows**: PowerShell `Start-Process -FilePath cmd.exe -Verb RunAs -Wait` copying temp file to target.
    - **macOS**: `osascript` `do shell script "cp ... && chmod ..." with administrator privileges` with shell-escaped single-quoted paths.
    - **Linux**: `pkexec cp --no-preserve=ownership <temp> <target>`.
  - Cancellation, missing elevation helper, or permission denial returns an explicit `cancelled:` / `unsupported:` / `permission:` error so the UI never loses unsaved edits and keeps "Save As..." available (`AC-16`).

## S-6: Cross-Platform Move to Trash (`viewer_trash`)

- **Conclusion**: **Feasible by reusing `src-tauri/src/filebrowser/local_ops/trash.rs`.**
- **Analysis**:
  - `filebrowser/local_ops/trash.rs` already uses `trash = "5"` on Linux (freedesktop Trash) and Windows (Recycle Bin) and `NSFileManager::trashItemAtURL` on macOS, handling canonicalization and error reporting cleanly.
  - Exposing `pub(crate) fn trash_single_entry(path: &str) -> Result<String, String>` allows `viewer_trash` to reuse the exact battle-tested cross-platform implementation without duplicating trash logic (`AC-03`, `DEC-03`).
