# HBase Client UI — Full Parity Plan

Bring the HBase shell session up to the MySQL `DbClientTab` "query session"
experience, with special attention to the object-tree right-click menu, a
complete/accurate command help surface, and a **forced confirmation popup on
every write operation**.

## Decisions (confirmed)
- **Full parity** workspace: multiple query tabs, multiple result sheets per
  tab, editor/result split, autosave + restore — mirroring `DbClientTab`.
- **Implement missing commands in the backend** (`count`, `exists`, `enable`,
  `disable`, `alter`) where the transport allows, and gate the rest in the UI.
- Object-tree write actions **confirm then execute**; read actions run
  immediately; command-builder actions insert a template into the editor.

## Current state (findings)
- `HBaseShellTab.tsx` (657 lines): bespoke single `<textarea>` editor + basic
  `ResultTable` + flat table list with hover `scan`/`get`. **No context menu,
  no write confirmation.**
- `COMMON_COMMANDS` offers `whoami`, `show_filters`, `count`, `exists` — none
  are parsed by the backend, so they error today.
- Backend (`src-tauri/src/hbase/mod.rs`) parser supports only: `help`, `list`,
  `status`, `version`, `describe`/`desc`, `create`, `drop`, `get`, `scan`,
  `put`, `delete`, `deleteall`. `enable`/`disable`/`alter`/`count` → error arm.
- Reusable as-is: `QueryResultGrid` (sort/filter/search/export/copy/inline-edit,
  driven by a `DbQueryResult`), `SqlEditorPanel` (CodeMirror, falls back to
  StandardSQL for unknown engine, schema-aware autocomplete), `useContextMenu`/
  `MenuItem`, `useConfirmDialog`/`useTextInputDialog`, `DbObjectDetailDialog`,
  `useDbSessionFontSize`, `resizableLayout`.
- `hbaseDescribeTable(sessionId, table)` returns `{ name, columnFamilies:
  [{ name, attributes }] }` — the analog of "columns" for the tree.
- Per-transport admin capability:
  - **native (RPC)** & **thrift (THBaseService)**: full admin available
    (`enable_table`, `disable_table`, `is_table_enabled`, `createTable`,
    `deleteTable`) → can implement count/exists/enable/disable/alter.
  - **REST/Stargate**: no enable/disable/alter endpoints. `exists` via
    `GET /<table>/schema` (200/404); `count` via key-only scanner emulation;
    admin ops return a clear "unsupported on REST" error and are UI-gated.

## Architecture approach
`DbClientTab`'s workspace machinery (panels, result sheets, autosave/restore,
toolbar, status bar) is implemented inline and SQL-specialized — extracting it
is high risk. Plan builds a **parallel HBase workspace** that reuses the leaf
components (`SqlEditorPanel`, `QueryResultGrid`, `ContextMenu`, dialogs,
`resizableLayout`, `useDbSessionFontSize`) and copies the panel/sheet/autosave
patterns adapted to HBase. `DbClientTab.tsx` stays untouched. A future shared
`QueryWorkspace` extraction is noted but out of scope.

---

## Phase 0 — Shared command model + result adapter
New `src/lib/hbaseCommands.ts`:
- `hbaseResultToGrid(r: HBaseShellResult): DbQueryResult` — map `columns:
  string[]` → `[{name, type:"text"}]`, pass rows, `rowsAffected: 0`,
  `durationMs`, `warnings`.
- `HBASE_COMMANDS`: structured catalog entries `{ verb, category:
  "meta"|"read"|"ddl"|"dml", syntax, example, description, isWrite,
  destructive, transports: ("rest"|"native"|"thrift")[] }`.
- `classifyStatement(stmt)` → `{ verb, isWrite, destructive }`;
  `isWriteCommand(stmt)` convenience.
- Command builders (with a shared `shellQuote`): `scanStatement`,
  `getStatement`, `putStatement`, `deleteStatement`, `deleteAllStatement`,
  `describeStatement`, `createTemplate`, `dropStatement`, `countStatement`,
  `existsStatement`, `enableStatement`, `disableStatement`, `alterTemplate`.
- Tests: `src/lib/hbaseCommands.test.ts` (classify / isWrite / builders),
  mirroring `hbaseStatements.test.ts`.

## Phase 1 — Backend: implement missing commands
`src-tauri/src/hbase/mod.rs` (+ `native/client.rs`, `thrift/mod.rs`):
- Extend `ShellCommand` enum: `Count{table}`, `Exists{table}`,
  `Enable{table}`, `Disable{table}`, `Alter{table, families}`.
- Parser: replace the `"enable"|"disable"|"alter"|"count" => Err` arm with real
  parsing; add `exists`. `alter` reuses `parse_family_spec`.
- REST `execute_command`:
  - `exists` → `GET /<table>/schema`; 200 → exists=true, 404 → false.
  - `count` → open a scanner with a key-only filter (FirstKeyOnlyFilter /
    KeyOnlyFilter), page through, return the count.
  - `enable`/`disable`/`alter` → return explicit
    `"<verb> is not supported by the HBase REST transport; use a native or
    Thrift connection"`.
- `native_execute` (RPC): `enable`/`disable` via DisableTable/EnableTable RPCs
  (DisableTable already wired for drop); `alter` via ModifyTable schema; `count`
  via key-only scan; `exists` via table-exists/describe probe.
- `thrift_execute`: `enable_table`/`disable_table`/`is_table_enabled`,
  `createTable`/admin for `alter`, scan-count, `get_table_names` for `exists`.
- Add a `hbase_command_capabilities(connectionMode)`-style helper (or static
  map in `hbaseCommands.ts`) so the UI can gate per transport.
- Update `help_result` to include the new verbs + transport caveats.
- Backend tests: parser arms + REST `exists`/`count` paths; extend
  `thrift/tests.rs` for enable/disable/exists.

## Phase 2 — `HBaseSchemaTree` (object tree + right-click menus) ⭐
New `src/components/database/HBaseSchemaTree.tsx`, modeled on `SchemaTree.tsx`:
- Hierarchy: optional **namespace** grouping (split `ns:table` from `list`,
  else flat) → **Tables** → **Column families** (expand via
  `hbaseDescribeTable`, with attribute tooltips).
- Reuse `useContextMenu`, `useConfirmDialog`, `useTextInputDialog`,
  `DbObjectDetailDialog`.
- Props (engine-agnostic, like `SchemaTree`): `onInsertText`, `onQuickScan`
  (browse → run scan), `onInsertCommand` (template → new query panel),
  `onNewQuery`, `onStatus`, `onExecuteWrite(stmt, {destructive})` (confirm +
  run), `onSchemaLoaded` (table → families, for autocomplete).
- Context menus:
  - **Root / namespace**: Refresh · New table… (create template to editor) ·
    New query.
  - **Table**: Browse (scan LIMIT N) · Scan with options… · Get row… (prompt) ·
    Count rows · Describe (→ `DbObjectDetailDialog`, synthesize `create`-style
    DDL from schema) · Insert scan/get/put/delete to editor · Copy name ·
    Enable / Disable · Alter… · Truncate… · **Drop** — write actions confirm;
    transport-unsupported items disabled with tooltip.
  - **Column family**: Scan this family (scan `COLUMNS=>['cf']`) · Copy name ·
    Alter family… · Drop family (alter-remove) — gated/confirmed.
- Selection/expand/badges styled to match `SchemaTree` (`taomni-tree-row`,
  row-count/region badge optional). Preserve `data-testid` hooks.

## Phase 3 — HBase query workspace (rewrite `HBaseShellTab.tsx`)
Restructure to mirror `DbClientTab`:
- **Left panel**: `HBaseSchemaTree` (collapsible; keep
  `data-testid="hbase-sidebar-drawer-handle"` drawer).
- **Right panel**: query-tab strip (panels, `MAX_PANELS`) → vertical split:
  - `SqlEditorPanel` with `engine="HBase"`; feed an autocomplete map of command
    verbs + table/family names.
  - `ResultArea`: result sheets (one per executed statement) + **Results /
    Messages** sub-tabs, rendering `QueryResultGrid` (read-only; `onCommitChanges`
    omitted initially — see Phase 5 optional).
- **Editor toolbar** (mirror `EditorToolbar`): Run (Ctrl/Cmd+Enter, F5) · Run
  selection · Cancel · **Commands** (categorized palette, replaces
  `COMMON_COMMANDS`) · History · row-limit (scan `LIMIT`) input · namespace
  label.
- **Status bar**: rows / cols / affected / ms + running spinner + elapsed,
  matching `DbClientTab`'s `StatusBar`.
- **Execution**: split via `splitHBaseStatements`; per statement → new result
  sheet via `hbaseResultToGrid`; stop block on first error; refresh tree after
  create/drop/enable/disable/alter.
- **Persistence (full parity)**: per-session `localStorage` workspace cache +
  temp-file autosave + restore-on-mount, copying `DbClientTab`'s pattern (keys
  namespaced `taomni.hbase.*`).
- Per-panel **history** dropdown.

## Phase 4 — Forced write confirmation
- Central `confirmWriteIfNeeded(stmt): Promise<boolean>` using
  `useConfirmDialog`: when `isWriteCommand(stmt)`, show a **mandatory** popup
  (no "don't ask again") with the exact command, `danger` styling for
  destructive verbs (drop/delete/deleteall/disable/truncate), and a clear
  warning line.
- Apply at **every** write entry point:
  - workspace `run()` — before each write statement in a block (confirm per
    statement as reached; cancel aborts the remainder of the block).
  - `HBaseSchemaTree` write actions (drop/enable/disable/alter/truncate/put/
    delete).
  - `QueryResultGrid` commit path if wired (Phase 5 optional).
- All writes are confirmed (per the requirement); destructive ones are styled
  red.

## Phase 5 — Command help completion
- Replace `COMMON_COMMANDS` with a **categorized palette** sourced from
  `HBASE_COMMANDS`: Meta · Read · Write/DDL · Write/DML, each with label,
  syntax, example, one-line description; click inserts a template (writes still
  gated on run). Transport-unsupported verbs disabled with tooltip.
- Optional richer **in-app help dialog** listing all commands grouped by
  category with examples (beyond the backend `help` table).
- Ensure backend `help` output and the palette agree (single source of truth in
  `hbaseCommands.ts`).
- (Optional) wire `QueryResultGrid.onCommitChanges` → `put`/`delete` builders
  (row-key + `cf:qualifier` mapping) behind the same write confirmation; keep
  read-only if mapping proves fragile.

## Phase 6 — i18n, tests, verification
- i18n: add `hbaseObjects.*` keys (menu labels, confirm messages, dialog titles,
  help text) in `src/lib/i18n/locales/en.ts` and `zh-CN.ts`.
- Tests:
  - `hbaseCommands.test.ts` (classify / isWrite / builders).
  - Rust: parser arms + REST `exists`/`count`; extend `thrift/tests.rs`.
  - Component: `HBaseSchemaTree` renders expected menu items; a write action
    opens the confirm dialog; `run()` of a write statement shows the popup.
  - Keep/adapt `hbaseStatements.test.ts`.
- Verify: `pnpm test`, `tsc -b` / `vite build`; `cargo build` + `cargo test` in
  `src-tauri`.

---

## Risks / notes
- **REST limits**: enable/disable/alter genuinely unavailable; count is a scan
  emulation (cost on large tables — cap/iterate with a sane default). UI must
  gate by `info.connectionMode` and surface clear errors.
- **Duplication**: full workspace parity copies `DbClientTab` logic; flag a
  future shared `QueryWorkspace` extraction.
- **Grid inline-edit → HBase write** mapping (row-key/`cf:q`) is non-trivial;
  default to read-only grid, treat commit wiring as optional.
- Keep `DbClientTab.tsx` untouched to avoid regressing the working SQL client.

## Suggested order
0 → 1 (backend) in parallel with 0/2 (frontend model + tree) → 3 (workspace) →
4 (write confirm) → 5 (help) → 6 (i18n/tests). Phases 2 and 4 cover the
explicitly-emphasized asks (context menu + forced write popup).
