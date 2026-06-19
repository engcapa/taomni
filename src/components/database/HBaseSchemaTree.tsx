import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  ChevronDown,
  ChevronRight,
  Columns3,
  Database,
  Loader2,
  RefreshCw,
  Table2,
} from "lucide-react";
import {
  hbaseCancel,
  hbaseDescribeTable,
  hbaseListTables,
  type HBaseColumnFamily,
} from "../../lib/ipc";
import {
  alterTemplate,
  commandSupported,
  countStatement,
  createTemplate,
  describeStatement,
  disableStatement,
  dropStatement,
  enableStatement,
  existsStatement,
  getStatement,
  putStatement,
  scanStatement,
  deleteStatement,
  deleteAllStatement,
  type HBaseTransport,
} from "../../lib/hbaseCommands";
import { useT } from "../../lib/i18n";
import { writeText } from "../../lib/clipboard";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { useTextInputDialog } from "../sidebar/ConfirmDialog";
import { DbObjectDetailDialog, type ObjectDetail } from "./DbObjectDetailDialog";

export interface HBaseSchemaTreeProps {
  /** Runtime connection session id (null while connecting). */
  sessionId: string | null;
  /** Transport, used to gate admin verbs not available on REST. */
  transport: HBaseTransport;
  namespace?: string | null;
  /** Endpoint summary shown under the header. */
  endpoint?: string;
  /** Bumped by the parent to force a table-list reload (e.g. after a mutation). */
  refreshSignal?: number;
  /** Run a (read or confirmed-write) command and show its result in the grid. */
  onRunCommand?: (statement: string) => void;
  /** Insert a command template into the editor for review. */
  onInsert?: (statement: string, target?: "cursor" | "newPanel") => void;
  /** Open a fresh, empty query panel. */
  onNewQuery?: () => void;
  /** Surface a transient status message. */
  onStatus?: (message: string) => void;
  /** Bubble up table names (for editor autocomplete). */
  onTablesLoaded?: (tables: string[]) => void;
  /** Bubble up a table's column families (for editor autocomplete). */
  onFamiliesLoaded?: (table: string, families: string[]) => void;
}

interface NamespaceGroup {
  /** Namespace label, or null for unqualified tables. */
  namespace: string | null;
  tables: { full: string; short: string }[];
}

/** Split a flat table list into namespace groups (only when any are qualified). */
function groupByNamespace(tables: string[]): { grouped: boolean; groups: NamespaceGroup[] } {
  const hasQualified = tables.some((t) => t.includes(":"));
  if (!hasQualified) {
    return {
      grouped: false,
      groups: [{ namespace: null, tables: tables.map((t) => ({ full: t, short: t })) }],
    };
  }
  const byNs = new Map<string, { full: string; short: string }[]>();
  for (const full of tables) {
    const idx = full.indexOf(":");
    const ns = idx >= 0 ? full.slice(0, idx) : "default";
    const short = idx >= 0 ? full.slice(idx + 1) : full;
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns)!.push({ full, short });
  }
  const groups = [...byNs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([namespace, tbls]) => ({ namespace, tables: tbls }));
  return { grouped: true, groups };
}

/** Synthesize a `create` statement from a table's column families (for DDL view). */
function synthesizeCreateDdl(table: string, families: HBaseColumnFamily[]): string {
  if (families.length === 0) return `create '${table}', 'cf1'`;
  const specs = families.map((f) => {
    const attrs = Object.entries(f.attributes ?? {}).map(([k, v]) => `${k} => '${v}'`);
    return attrs.length > 0 ? `{NAME => '${f.name}', ${attrs.join(", ")}}` : `'${f.name}'`;
  });
  return `create '${table}',\n  ${specs.join(",\n  ")}`;
}

const SCAN_PREVIEW_LIMIT = 50;

interface FamilyState {
  expanded: boolean;
  families?: HBaseColumnFamily[];
  loading?: boolean;
}

export function HBaseSchemaTree({
  sessionId,
  transport,
  namespace,
  endpoint,
  refreshSignal = 0,
  onRunCommand,
  onInsert,
  onNewQuery,
  onStatus,
  onTablesLoaded,
  onFamiliesLoaded,
}: HBaseSchemaTreeProps) {
  const t = useT();
  const inputDialog = useTextInputDialog();
  const { show: openMenu, render: menu } = useContextMenu();

  const [tables, setTables] = useState<string[]>([]);
  const [visibleCount, setVisibleCount] = useState(50);
  const [loading, setLoading] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tableState, setTableState] = useState<Record<string, FamilyState>>({});
  const [expandedNs, setExpandedNs] = useState<Record<string, boolean>>({});
  const [detail, setDetail] = useState<ObjectDetail | null>(null);

  const adminEnabled = useCallback(
    (verb: string) => commandSupported(verb, transport),
    [transport],
  );

  const loadTables = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setTimedOut(false);
    setError(null);
    let timeoutId: number | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error("TIMEOUT")), 60000);
    });
    try {
      const res = await Promise.race([hbaseListTables(sessionId), timeoutPromise]);
      if (timeoutId) window.clearTimeout(timeoutId);
      const names = res.map((tbl) => tbl.name);
      setTables(names);
      setVisibleCount(50);
      onTablesLoaded?.(names);
    } catch (err) {
      if (timeoutId) window.clearTimeout(timeoutId);
      const msg = String(err);
      if (err instanceof Error && err.message === "TIMEOUT") {
        setTimedOut(true);
        setTables([]);
      } else if (msg.includes("cancel") || msg.includes("Cancel")) {
        setError(t("hbaseObjects.loadCancelled"));
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [sessionId, onTablesLoaded, t]);

  useEffect(() => {
    if (sessionId) void loadTables();
  }, [sessionId, loadTables, refreshSignal]);

  const cancelLoad = useCallback(() => {
    if (sessionId) void hbaseCancel(sessionId);
  }, [sessionId]);

  const toggleTable = useCallback(
    async (full: string) => {
      const current = tableState[full];
      const expanded = !current?.expanded;
      setTableState((prev) => ({ ...prev, [full]: { ...prev[full], expanded } }));
      if (expanded && !current?.families && sessionId) {
        setTableState((prev) => ({ ...prev, [full]: { ...prev[full], expanded, loading: true } }));
        try {
          const schema = await hbaseDescribeTable(sessionId, full);
          setTableState((prev) => ({
            ...prev,
            [full]: { expanded: true, families: schema.columnFamilies, loading: false },
          }));
          onFamiliesLoaded?.(full, schema.columnFamilies.map((f) => f.name));
        } catch (err) {
          setError(String(err));
          setTableState((prev) => ({ ...prev, [full]: { expanded: true, loading: false } }));
        }
      }
    },
    [sessionId, tableState, onFamiliesLoaded],
  );

  const copyName = useCallback(
    async (name: string) => {
      await writeText(name);
      onStatus?.(t("dbObjects.copied"));
    },
    [onStatus, t],
  );

  const viewSchema = useCallback(
    async (table: string) => {
      if (!sessionId) return;
      try {
        const schema = await hbaseDescribeTable(sessionId, table);
        setDetail({
          kind: "ddl",
          title: t("hbaseObjects.schemaTitle", { name: table }),
          sql: synthesizeCreateDdl(table, schema.columnFamilies),
        });
      } catch (err) {
        setError(String(err));
        onStatus?.(t("dbObjects.failed", { error: String(err) }));
      }
    },
    [sessionId, onStatus, t],
  );

  const promptGetRow = useCallback(
    async (table: string) => {
      const row = await inputDialog.promptText({
        title: t("hbaseObjects.getRowTitle", { name: table }),
        label: t("hbaseObjects.getRowLabel"),
        placeholder: "row-key",
      });
      if (row) onRunCommand?.(getStatement(table, row));
    },
    [inputDialog, onRunCommand, t],
  );

  const promptScanLimit = useCallback(
    async (table: string, columns?: string[]) => {
      const value = await inputDialog.promptText({
        title: t("hbaseObjects.scanLimitTitle", { name: table }),
        label: t("hbaseObjects.scanLimitLabel"),
        initialValue: "50",
      });
      if (value == null) return;
      const limit = Number.parseInt(value, 10);
      onInsert?.(scanStatement(table, { limit: Number.isFinite(limit) ? limit : 50, columns }), "cursor");
    },
    [inputDialog, onInsert, t],
  );

  // MENUS_PLACEHOLDER
  const sep: MenuItem = { label: "", separator: true };

  const rootMenu = (): MenuItem[] => [
    { label: t("dbObjects.refresh"), onClick: () => void loadTables() },
    { label: t("hbaseObjects.newTable"), onClick: () => onInsert?.(createTemplate(), "newPanel") },
    { label: t("dbObjects.newQuery"), onClick: () => onNewQuery?.() },
  ];

  const tableMenu = (full: string): MenuItem[] => {
    const items: MenuItem[] = [
      { label: t("hbaseObjects.browse"), onClick: () => onRunCommand?.(scanStatement(full, { limit: SCAN_PREVIEW_LIMIT })) },
      { label: t("hbaseObjects.scanWithOptions"), onClick: () => void promptScanLimit(full) },
      { label: t("hbaseObjects.getRow"), onClick: () => void promptGetRow(full) },
      { label: t("hbaseObjects.count"), onClick: () => onRunCommand?.(countStatement(full)) },
      { label: t("hbaseObjects.exists"), onClick: () => onRunCommand?.(existsStatement(full)) },
      { label: t("hbaseObjects.describe"), onClick: () => onRunCommand?.(describeStatement(full)) },
      { label: t("hbaseObjects.viewSchema"), onClick: () => void viewSchema(full) },
      sep,
      {
        label: t("hbaseObjects.insertTo"),
        children: [
          { label: t("hbaseObjects.insertScan"), onClick: () => onInsert?.(scanStatement(full, { limit: SCAN_PREVIEW_LIMIT }), "cursor") },
          { label: t("hbaseObjects.insertGet"), onClick: () => onInsert?.(getStatement(full, "row-key"), "cursor") },
          { label: t("hbaseObjects.insertPut"), onClick: () => onInsert?.(putStatement(full, "row-key", "cf:q", "value"), "cursor") },
          { label: t("hbaseObjects.insertDelete"), onClick: () => onInsert?.(deleteStatement(full, "row-key", "cf:q"), "cursor") },
          { label: t("hbaseObjects.insertDeleteAll"), onClick: () => onInsert?.(deleteAllStatement(full, "row-key"), "cursor") },
        ],
      },
      { label: t("hbaseObjects.alter"), disabled: !adminEnabled("alter"), onClick: () => onInsert?.(alterTemplate(full), "cursor") },
      sep,
      { label: t("dbObjects.copyName"), onClick: () => void copyName(full) },
      sep,
      { label: t("hbaseObjects.enable"), disabled: !adminEnabled("enable"), onClick: () => onRunCommand?.(enableStatement(full)) },
      { label: t("hbaseObjects.disable"), danger: true, disabled: !adminEnabled("disable"), onClick: () => onRunCommand?.(disableStatement(full)) },
      { label: t("dbObjects.drop"), danger: true, onClick: () => onRunCommand?.(dropStatement(full)) },
    ];
    return items;
  };

  const familyMenu = (table: string, family: string): MenuItem[] => [
    { label: t("hbaseObjects.scanFamily"), onClick: () => onRunCommand?.(scanStatement(table, { limit: SCAN_PREVIEW_LIMIT, columns: [family] })) },
    { label: t("hbaseObjects.insertScanFamily"), onClick: () => onInsert?.(scanStatement(table, { limit: SCAN_PREVIEW_LIMIT, columns: [family] }), "cursor") },
    sep,
    { label: t("hbaseObjects.copyFamily"), onClick: () => void copyName(family) },
    { label: t("hbaseObjects.alterFamily"), disabled: !adminEnabled("alter"), onClick: () => onInsert?.(alterTemplate(table, family), "cursor") },
  ];

  // RENDER_PLACEHOLDER
  const { grouped, groups } = useMemo(() => groupByNamespace(tables), [tables]);

  const renderTableRow = (full: string, short: string, indent: number) => {
    const st = tableState[full];
    return (
      <div key={full}>
        <button
          type="button"
          className="taomni-tree-row w-full text-left"
          style={{ paddingLeft: indent }}
          title={full}
          onClick={() => void toggleTable(full)}
          onDoubleClick={() => onRunCommand?.(scanStatement(full, { limit: SCAN_PREVIEW_LIMIT }))}
          onContextMenu={(e) => openMenu(e, tableMenu(full))}
        >
          {st?.expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <Table2 className="w-3.5 h-3.5" style={{ color: "#3b7ac2" }} />
          <span className="flex-1 truncate">{short}</span>
        </button>
        {st?.expanded && (
          <div>
            {st.loading && (
              <div className="px-2 py-0.5 text-[var(--taomni-text-muted)]" style={{ paddingLeft: indent + 16 }}>
                {t("hbaseObjects.loadingFamilies")}
              </div>
            )}
            {st.families?.length === 0 && !st.loading && (
              <div className="px-2 py-0.5 text-[var(--taomni-text-muted)]" style={{ paddingLeft: indent + 16 }}>—</div>
            )}
            {st.families?.map((fam) => (
              <button
                key={fam.name}
                type="button"
                className="taomni-tree-row w-full text-left"
                style={{ paddingLeft: indent + 16 }}
                title={Object.entries(fam.attributes ?? {}).map(([k, v]) => `${k}=${v}`).join(", ") || fam.name}
                onContextMenu={(e) => openMenu(e, familyMenu(full, fam.name))}
                onDoubleClick={() => onInsert?.(scanStatement(full, { limit: SCAN_PREVIEW_LIMIT, columns: [fam.name] }), "cursor")}
              >
                <Columns3 className="w-3 h-3 text-[var(--taomni-text-muted)]" />
                <span className="flex-1 truncate">{fam.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col" data-testid="hbase-schema-tree">
      <div
        className="h-8 flex items-center gap-1.5 px-2 border-b text-[12px] font-semibold shrink-0"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        onContextMenu={(e) => openMenu(e, rootMenu())}
      >
        <Database className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
        <span className="truncate flex-1" title={namespace ? `namespace: ${namespace}` : undefined}>HBase</span>
        <button
          type="button"
          className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] shrink-0"
          title={t("dbObjects.refresh")}
          onClick={() => void loadTables()}
          disabled={!sessionId || loading}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        </button>
      </div>
      {endpoint && (
        <div
          className="px-2 py-1.5 text-[11px] text-[var(--taomni-text-muted)] border-b truncate shrink-0"
          style={{ borderColor: "var(--taomni-divider)" }}
          title={endpoint}
        >
          {endpoint}
        </div>
      )}
      <div
        className="flex-1 min-h-0 overflow-auto taomni-scroll-y py-1 text-[12px]"
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) openMenu(e, rootMenu());
        }}
      >
        {!sessionId && (
          <div className="px-2 py-2 text-[var(--taomni-text-muted)] flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" /> <span>{t("hbaseObjects.connecting")}</span>
          </div>
        )}
        {loading && (
          <div className="px-2 py-2 text-[var(--taomni-text-muted)] flex items-center justify-between border-b" style={{ borderColor: "var(--taomni-divider)" }}>
            <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("hbaseObjects.loadingTables")}</span>
            <button type="button" className="taomni-btn px-1.5 py-0.5 text-[10px] flex items-center gap-0.5" onClick={cancelLoad} title={t("hbaseObjects.cancelLoad")}>
              <Ban className="w-3 h-3" style={{ color: "#d9534f" }} /> {t("hbaseObjects.cancel")}
            </button>
          </div>
        )}
        {timedOut && (
          <div className="px-2 py-2 text-[11px] flex flex-col gap-1.5 border-b" style={{ borderColor: "var(--taomni-divider)" }}>
            <span className="text-amber-500 font-medium">{t("hbaseObjects.loadTimedOut")}</span>
            <button type="button" className="taomni-btn self-start px-2 py-1 text-[10px]" onClick={() => void loadTables()}>{t("hbaseObjects.retryLoad")}</button>
          </div>
        )}
        {error && <div className="px-2 py-1 text-[11px]" style={{ color: "#d9534f" }}>{error}</div>}
        {sessionId && !loading && !timedOut && tables.length === 0 && (
          <div className="px-2 py-1 text-[var(--taomni-text-muted)]">{t("hbaseObjects.noTables")}</div>
        )}
        {!loading && grouped &&
          groups.map((g) => {
            const key = g.namespace ?? "(default)";
            const open = expandedNs[key] ?? true;
            return (
              <div key={key}>
                <button
                  type="button"
                  className="taomni-tree-row w-full text-left"
                  onClick={() => setExpandedNs((p) => ({ ...p, [key]: !open }))}
                >
                  {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <Database className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
                  <span className="flex-1 truncate">{key}</span>
                  <span className="text-[10px] text-[var(--taomni-text-muted)]">{g.tables.length}</span>
                </button>
                {open && g.tables.map((tbl) => renderTableRow(tbl.full, tbl.short, 18))}
              </div>
            );
          })}
        {!loading && !grouped &&
          groups[0].tables.slice(0, visibleCount).map((tbl) => renderTableRow(tbl.full, tbl.short, 6))}
        {!loading && !grouped && tables.length > visibleCount && (
          <div className="px-2 py-1.5 flex justify-center border-t mt-1" style={{ borderColor: "var(--taomni-divider)" }}>
            <button
              type="button"
              className="taomni-btn w-full py-1 text-[11px] font-semibold flex items-center justify-center gap-1"
              onClick={() => setVisibleCount((c) => c + 50)}
            >
              {t("hbaseObjects.more", { count: tables.length - visibleCount })}
            </button>
          </div>
        )}
      </div>
      {menu}
      {inputDialog.render}
      {detail && <DbObjectDetailDialog detail={detail} onClose={() => setDetail(null)} onStatus={onStatus} />}
    </div>
  );
}



