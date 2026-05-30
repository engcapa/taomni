# Redis Client UI

## What & Why
Redis is a fundamentally different database — key-value / data-structure store with no tables or SQL. This task builds a dedicated Redis client UI inside its own `"redis"` tab type, giving users a visual key browser, type-aware value viewer/editor, and an integrated Redis CLI panel. The connection backend is provided by the Database Connection Foundation task.

## Done looks like
- Opening a Redis session from the session tree opens a new `"redis"` tab. The tab title shows the Redis logo/icon + host:port + DB index.
- **Left pane — Key browser**:
  - A search/filter bar at the top with a glob pattern input (`*` by default). Hitting Enter or clicking the refresh icon runs a SCAN and populates the list.
  - Keys grouped by prefix (using `:` as the default separator, user-configurable). Folder nodes can be expanded/collapsed. Total key count shown in the pane header.
  - Each key row shows its type badge (STRING / HASH / LIST / SET / ZSET / STREAM), name, and TTL pill (green = persistent, yellow = expiring, red = < 60 s). TTLs refresh every 10 s automatically.
  - Toolbar actions: Refresh, Add key (opens a "New key" dialog), Delete selected key(s), Set TTL.
  - Clicking a key loads its value in the right pane.
- **Right pane — Value viewer/editor**:
  - **String**: a textarea showing the raw string value. "Save" button calls `redis_set_key`. If the value is valid JSON, a "Format JSON" toggle pretty-prints it with syntax highlighting.
  - **Hash**: a two-column table (field → value) with inline editing per cell. "Add field" row at the bottom. Delete icon per field.
  - **List**: a numbered list. Add item (RPUSH), remove item (LREM), drag-to-reorder (LSET). Paginated in chunks of 100 (LRANGE cursor).
  - **Set**: a flat list of members. Add member (SADD), remove member (SREM). No ordering.
  - **ZSet (Sorted Set)**: a two-column table (score | member), sorted by score. Add member with score (ZADD), remove member (ZREM), update score.
  - **Stream**: shows entries as an append-only log table (entry-id | field | value triplets). Read via XRANGE cursor with a "Load more" button.
  - A key metadata bar above the value shows: type badge, TTL with an "Edit TTL" pencil, encoding (OBJECT ENCODING), memory usage (MEMORY USAGE), and a "Delete key" button.
- **Bottom pane — Redis CLI panel** (collapsible, similar to the SFTP transfer queue):
  - A single-line input field with command history (Up/Down arrows) and Tab autocomplete of known Redis commands.
  - Output area showing past command/response pairs (RESP plain text). RESP errors displayed in red.
  - "Clear" button. The CLI uses `redis_exec` per command.
  - The CLI is always available regardless of what is selected in the key browser.
- DB index switcher: a small `SELECT 0–15` dropdown in the tab toolbar. Switching index calls `redis_exec("SELECT n")` and refreshes the key browser.
- Pub/Sub monitor toggle: a "Monitor" button that subscribes to `MONITOR` output and streams it into a read-only log area inside the CLI pane (stops when toggled off).
- The tab is kept mounted when switching away.

## Out of scope
- Cluster topology view or Sentinel failover UI.
- ACL / keyspace notifications configuration.
- RDB snapshot download.
- Lua scripting editor.

## Steps
1. **`RedisClientTab` component shell** — Create `src/components/database/RedisClientTab.tsx` with a resizable layout (key browser | value viewer, plus collapsible CLI pane at the bottom). Wire it into the tab renderer for the `"redis"` `TabKind`. Call `db_connect` (Redis) on mount, `db_disconnect` on unmount.
2. **Key browser** — Implement `RedisKeyBrowser` component: SCAN-backed paginated key list with prefix grouping, type badges, TTL pills, filter input. Calls `redis_list_keys` with cursor pagination; "Load more" or auto-load next page on scroll.
3. **Value viewer/editor** — Implement `RedisValuePanel` with a switch on `kind`: String, Hash, List, Set, ZSet, Stream sub-components. Each calls the appropriate `redis_get_key` / `redis_set_key` / `redis_del_key` commands. Pagination for large collections.
4. **Key metadata bar** — Show type, TTL (editable via `redis_exec("EXPIRE key secs")`), encoding, memory, and delete action above the value panel.
5. **Redis CLI panel** — Implement `RedisCli` component: command input with history (`useRef` array, up/down navigation), output log, calls `redis_exec`. Auto-scroll to bottom on new output. Collapsible with a drawer handle at the bottom of the tab.
6. **DB index switcher + Monitor mode** — Add DB selector dropdown in the tab toolbar. Add Monitor toggle that streams `MONITOR` output into the CLI pane via a `redis_exec("MONITOR")` long-running channel (use a Tauri Channel callback similar to terminal output).
7. **"New key" dialog** — A small modal with type selector (String/Hash/List/Set/ZSet), key name, initial value, and optional TTL. Calls the appropriate `redis_set_key` variant on submit.

## Relevant files
- `src/types/index.ts`
- `src/layouts/MainLayout.tsx`
- `src/stores/appStore.ts`
- `src/components/filebrowser/FileBrowser.tsx`
- `src/components/database/DbClientTab.tsx`
- `src/lib/ipc.ts`
- `src-tauri/src/database/`
