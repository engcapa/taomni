import { useEffect, useState, useCallback } from "react";
import {
  ChevronRight,
  ChevronDown,
  Database,
  Table2,
  Eye,
  Columns3,
  KeyRound,
  RefreshCw,
  ListTree,
} from "lucide-react";
import {
  dbListSchemas,
  dbListTables,
  dbDescribeTable,
  dbListIndexes,
  type DbTable,
  type DbColumnDescription,
  type DbIndex,
} from "../../lib/ipc";
import { useContextMenu, type MenuItem } from "../ContextMenu";

interface SchemaTreeProps {
  sessionId: string;
  engine: string;
  /** Called when a table is selected (single click). */
  onSelectTable?: (schema: string | null, table: string) => void;
  /** Called when a table is double-clicked — inserts its name into the editor. */
  onInsertTable?: (table: string) => void;
  /** "Select top N rows" context action. */
  onQuickSelect?: (schema: string | null, table: string) => void;
  quickSelectLimit?: number;
  /** Bubble up schema names for the editor toolbar selector. */
  onSchemasLoaded?: (schemas: string[]) => void;
  /** Bubble up the loaded schema → tables/columns for editor autocomplete. */
  onSchemaLoaded?: (tables: Map<string, string[]>) => void;
}

interface TableNodeState {
  expanded: boolean;
  columns?: DbColumnDescription[];
  indexes?: DbIndex[];
  loading?: boolean;
}

function formatRowCount(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

export function SchemaTree({
  sessionId,
  engine,
  onSelectTable,
  onInsertTable,
  onQuickSelect,
  quickSelectLimit = 1000,
  onSchemasLoaded,
  onSchemaLoaded,
}: SchemaTreeProps) {
  const [schemas, setSchemas] = useState<string[]>([]);
  const [expandedSchemas, setExpandedSchemas] = useState<Record<string, boolean>>({});
  const [tablesBySchema, setTablesBySchema] = useState<Record<string, DbTable[]>>({});
  const [tableState, setTableState] = useState<Record<string, TableNodeState>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const { show: openMenu, render: menu } = useContextMenu();

  const tableKey = (schema: string, table: string) => JSON.stringify([schema, table]);

  const loadSchemas = useCallback(async () => {
    setLoadingSchemas(true);
    setError(null);
    try {
      const list = await dbListSchemas(sessionId);
      const names = list.map((s) => s.name);
      setSchemas(names);
      onSchemasLoaded?.(names);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingSchemas(false);
    }
  }, [sessionId, onSchemasLoaded]);

  useEffect(() => {
    void loadSchemas();
  }, [loadSchemas]);

  const loadTables = useCallback(
    async (schema: string) => {
      try {
        const list = await dbListTables(sessionId, schema);
        setTablesBySchema((prev) => ({ ...prev, [schema]: list }));
        // Feed autocomplete: schema's table names (columns added on expand).
        onSchemaLoaded?.(
          new Map(list.map((t) => [t.name, [] as string[]])),
        );
      } catch (err) {
        setError(String(err));
      }
    },
    [sessionId, onSchemaLoaded],
  );

  const toggleSchema = (schema: string) => {
    const next = !expandedSchemas[schema];
    setExpandedSchemas((prev) => ({ ...prev, [schema]: next }));
    if (next && !tablesBySchema[schema]) void loadTables(schema);
  };

  const toggleTable = async (schema: string, table: string) => {
    const key = tableKey(schema, table);
    const current = tableState[key];
    const expanded = !current?.expanded;
    setTableState((prev) => ({ ...prev, [key]: { ...prev[key], expanded } }));
    if (expanded && !current?.columns) {
      setTableState((prev) => ({ ...prev, [key]: { ...prev[key], expanded, loading: true } }));
      try {
        const [columns, indexes] = await Promise.all([
          dbDescribeTable(sessionId, schema, table),
          dbListIndexes(sessionId, schema, table).catch(() => [] as DbIndex[]),
        ]);
        setTableState((prev) => ({
          ...prev,
          [key]: { expanded: true, columns, indexes, loading: false },
        }));
        onSchemaLoaded?.(new Map([[table, columns.map((col) => col.name)]]));
      } catch (err) {
        setError(String(err));
        setTableState((prev) => ({ ...prev, [key]: { expanded: true, loading: false } }));
      }
    }
  };

  const selectTable = (schema: string, table: string) => {
    setSelected(tableKey(schema, table));
    onSelectTable?.(schema, table);
  };

  const tableMenu = (schema: string, table: string): MenuItem[] => [
    {
      label: `Select top ${quickSelectLimit} rows`,
      onClick: () => onQuickSelect?.(schema, table),
    },
    {
      label: "Insert name into editor",
      onClick: () => onInsertTable?.(table),
    },
  ];

  return (
    <div className="h-full flex flex-col" data-testid="schema-tree">
      <div
        className="h-7 flex items-center gap-1 px-2 shrink-0 text-[11px] font-semibold"
        style={{
          background: "var(--taomni-quick-bg)",
          borderBottom: "1px solid var(--taomni-divider)",
          fontSize: "var(--taomni-db-font-size-sm, 11px)",
        }}
      >
        <Database className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
        <span className="truncate flex-1">{engine}</span>
        <button
          type="button"
          title="Refresh"
          className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
          onClick={() => {
            setTablesBySchema({});
            setTableState({});
            void loadSchemas();
          }}
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      <div
        className="flex-1 min-h-0 overflow-auto taomni-scroll-y py-1 text-[12px]"
        style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
      >
        {error && (
          <div className="px-2 py-1 text-[11px]" style={{ color: "#d9534f" }}>
            {error}
          </div>
        )}
        {loadingSchemas && schemas.length === 0 && (
          <div className="px-2 py-1 text-[var(--taomni-text-muted)]">Loading…</div>
        )}
        {schemas.map((schema) => (
          <div key={schema}>
            <button
              type="button"
              className="taomni-tree-row w-full text-left"
              onClick={() => toggleSchema(schema)}
            >
              {expandedSchemas[schema] ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <Database className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
              <span className="flex-1 truncate">{schema}</span>
            </button>
            {expandedSchemas[schema] &&
              (tablesBySchema[schema] ?? []).map((tbl) => {
                const key = tableKey(schema, tbl.name);
                const st = tableState[key];
                const isSel = selected === key;
                return (
                  <div key={tbl.name}>
                    <button
                      type="button"
                      className="taomni-tree-row w-full text-left"
                      style={{ paddingLeft: 18, background: isSel ? "var(--taomni-selected)" : undefined }}
                      onClick={() => {
                        selectTable(schema, tbl.name);
                        void toggleTable(schema, tbl.name);
                      }}
                      onDoubleClick={() => onInsertTable?.(tbl.name)}
                      onContextMenu={(e) => openMenu(e, tableMenu(schema, tbl.name))}
                      title={tbl.name}
                    >
                      {st?.expanded ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                      {tbl.kind === "view" || tbl.kind === "materialized_view" ? (
                        <Eye className="w-3.5 h-3.5" style={{ color: "#c97a23" }} />
                      ) : (
                        <Table2 className="w-3.5 h-3.5" style={{ color: "#3b7ac2" }} />
                      )}
                      <span className="flex-1 truncate">{tbl.name}</span>
                      {typeof tbl.rowCount === "number" && tbl.rowCount >= 0 && (
                        <span
                          className="text-[10px] rounded px-1"
                          style={{ background: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
                          title={`${tbl.rowCount.toLocaleString()} row(s)`}
                        >
                          {formatRowCount(tbl.rowCount)}
                        </span>
                      )}
                    </button>
                    {st?.expanded && (
                      <div>
                        {st.loading && (
                          <div className="px-2 py-0.5 text-[var(--taomni-text-muted)]" style={{ paddingLeft: 36 }}>
                            Loading…
                          </div>
                        )}
                        {st.columns?.map((col) => (
                          <div
                            key={col.name}
                            className="taomni-tree-row"
                            style={{ paddingLeft: 36, cursor: "default" }}
                            title={`${col.type}${col.nullable ? " NULL" : " NOT NULL"}`}
                          >
                            {col.primaryKey ? (
                              <KeyRound className="w-3 h-3" style={{ color: "#e6a817" }} />
                            ) : (
                              <Columns3 className="w-3 h-3 text-[var(--taomni-text-muted)]" />
                            )}
                            <span className="flex-1 truncate">{col.name}</span>
                            <span className="text-[10px] text-[var(--taomni-text-muted)] truncate max-w-[80px]">
                              {col.type}
                            </span>
                          </div>
                        ))}
                        {(st.indexes ?? []).length > 0 && (
                          <div
                            className="px-2 py-0.5 text-[10px] text-[var(--taomni-text-muted)] flex items-center gap-1"
                            style={{ paddingLeft: 36 }}
                          >
                            <ListTree className="w-3 h-3" /> Indexes
                          </div>
                        )}
                        {st.indexes?.map((idx) => (
                          <div
                            key={idx.name}
                            className="taomni-tree-row"
                            style={{ paddingLeft: 50, cursor: "default" }}
                            title={`${idx.columns.join(", ")}${idx.unique ? " (unique)" : ""}`}
                          >
                            <ListTree className="w-3 h-3 text-[var(--taomni-text-muted)]" />
                            <span className="flex-1 truncate">{idx.name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        ))}
      </div>
      {menu}
    </div>
  );
}
