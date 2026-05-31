# SQL Database Client UI

> **Status: ✅ Completed (2026-05-31).** `DbClientTab` (schema tree + query
> workspace), `SchemaTree`, CodeMirror 6 `SqlEditorPanel` with dialect +
> schema autocomplete, virtualised `QueryResultGrid` (sort/copy/CSV/NULL badge),
> up to 4 editor panels, query history, status bar + Messages tab, Cancel,
> "Select top 1000 rows", and CSV export are implemented and wired into
> `MainLayout` (always-mounted, spinner badge). Query execution uses
> `db_execute_stream` over a Tauri Channel so columns, row batches, and final
> status are delivered incrementally; `db_execute` remains for compatibility and
> small control statements such as schema switching.

## What & Why
With the connection backend in place (Task: Database Connection Foundation), this task builds the full interactive SQL client interface for MySQL, PostgreSQL, and ClickHouse — a DBeaver/DataGrip-style workspace inside a NewMob tab. The goal is a productive query environment that feels native to the app's existing dark-panel aesthetic.

## Done looks like
- Opening a MySQL/PostgreSQL/ClickHouse session from the session tree opens a new `"database"` tab. The tab title shows the DB engine icon + host + database name.
- **Left pane — Schema browser tree**: collapsible tree rooted at the connection. Nodes: Schemas/Databases → Tables → Columns (with type badge), Views, Indexes. Clicking a table selects it; double-clicking inserts its name into the active editor. A toolbar icon refreshes the tree. Tables show a row-count badge (lazy, loaded on expand). The pane width is user-resizable (saved to `localStorage` per session type).
- **Right pane — Query workspace**:
  - A **CodeMirror 6** SQL editor with: syntax highlighting (SQL dialect auto-detected from DB type), bracket matching, line numbers, multi-cursor, basic autocomplete from schema (table names, column names). The editor toolbar shows: Run (F5), Run selection, Cancel, Format SQL, and a schema/database selector dropdown.
  - Below the editor, a **result grid**: virtualised table (handles 10 000+ rows without layout jank), column headers with sort toggle, fixed-width vs. auto-fit toggle, copy-cell/copy-row/copy-as-CSV context menu. Null values shown as a distinct grey `NULL` badge. Numbers right-aligned.
  - A **status bar** under the grid: row count, columns, query duration, "rows affected" for DML statements, and an in-progress spinner with elapsed time while a query runs.
  - A **Messages / Errors** sub-tab next to the results shows server warnings and errors from the last execution.
- **Multiple editor panels**: a `+` button opens a second SQL editor panel in the same tab (split vertically by default); each panel is independent (own history, own result). Up to four panels per tab.
- **Query history**: each executed query is appended to an in-memory list (max 200 entries, newest first) accessible via a clock icon in the editor toolbar. Clicking a history entry pastes it into the editor.
- The `db_execute` command is called with the editor content (or selection if any text is selected). Partial results stream in as rows are received (uses Tauri Channel progress, same pattern as SFTP transfers).
- **Cancel**: the Cancel button calls `db_cancel(sessionId)` and greys out the grid while the server acknowledges.
- **Table quick-view**: right-clicking a table in the schema tree offers "Select top 1000 rows" which auto-generates and runs a `SELECT * FROM <table> LIMIT 1000` query.
- **Export**: toolbar button exports current result grid to CSV (downloaded via browser save dialog / OS dialog in Tauri).
- The tab is kept mounted when switching away (same pattern as standalone SFTP tabs) so long queries keep running.
- The tab shows a spinner badge (same `hasNewOutput` pattern) while a query is in-flight.

## Out of scope
- Redis key browser (separate task).
- Table data editing (inline cell edit / INSERT / UPDATE via grid — future work).
- ER diagram / visual schema designer.
- Schema migrations or DDL generation.
- Multiple simultaneous connections per tab (each tab = one session/connection).
- Saved query library with server-side storage.

## Steps
1. **Install CodeMirror 6** — Add `@codemirror/lang-sql`, `@codemirror/view`, `@codemirror/state`, `@codemirror/commands`, `@codemirror/autocomplete` to `package.json`. Confirm no conflicts with existing xterm deps.
2. **`DbClientTab` component shell** — Create `src/components/database/DbClientTab.tsx` with a resizable split (schema tree | query workspace) using `react-resizable-panels`. Wire it into `MainLayout` / the tab renderer so opening a `"database"` tab renders it. Accept `DbConnectInfo` as a prop, call `db_connect` on mount, `db_disconnect` on unmount.
3. **Schema browser tree** — Implement `SchemaTree` component: calls `db_list_schemas`, `db_list_tables`, `db_describe_table`, `db_list_indexes` lazily as nodes expand. Style with the existing `var(--moba-*)` CSS tokens (same tree look as `SessionTree`).
4. **CodeMirror SQL editor panel** — Implement `SqlEditorPanel` wrapping a CodeMirror 6 view. SQL dialect is selected based on DB type (MySQL / PostgreSQL / standard SQL for ClickHouse). Autocomplete extension pulls table/column names from the schema tree state. Toolbar: Run, Run selection, Cancel, Format SQL, panel-close (if >1 panel open).
5. **Result grid** — Implement `QueryResultGrid` using a virtualised list (`@tanstack/react-virtual` or hand-rolled with `react-resizable-panels`). Support column sort, cell copy, CSV export. Show `NULL` badge, right-align numbers. Wire to streamed results from `db_execute` via Tauri Channel.
6. **Multi-panel layout** — Add panel management: a tab strip within the query workspace for opening/closing multiple editor panels; each panel carries its own editor + result state.
7. **Query history dropdown** — Store history in a `useRef` list within `DbClientTab`; render as a popover list from the clock icon. Entry click replaces editor content.
8. **Status bar + error messages sub-tab** — Implement the bottom strip and the Messages tab, fed from the command result object (duration, rowsAffected, warnings array).

## Relevant files
- `src/types/index.ts`
- `src/layouts/MainLayout.tsx`
- `src/stores/appStore.ts`
- `src/components/terminal/TerminalPanel.tsx`
- `src/components/filebrowser/FileBrowser.tsx`
- `src/lib/ipc.ts`
- `src-tauri/src/database/`
