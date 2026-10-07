import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Database, RefreshCw, X } from "lucide-react";
import {
  dbDescribeTable,
  dbExecute,
  dbListForeignKeys,
  dbListIndexes,
  dbObjectDdl,
  dbTableStats,
  type DbColumnDescription,
  type DbForeignKey,
  type DbIndex,
  type DbQueryResult,
} from "../../lib/ipc";
import { useT } from "../../lib/i18n";
import { writeText } from "../../lib/clipboard";
import { asSqlEngine, selectStatement } from "../../lib/sqlDialect";

type DetailTab = "properties" | "data" | "diagram";

interface Props {
  sessionId: string;
  schema: string | null;
  table: string;
  kind?: "table" | "view" | "materialized_view";
  engine: string;
  catalog?: string | null;
  onClose: () => void;
  onStatus?: (message: string) => void;
  onOpenData?: () => void;
}

interface Metadata {
  columns: DbColumnDescription[];
  foreignKeys: DbForeignKey[];
  indexes: DbIndex[];
  stats: DbQueryResult | null;
  ddl: string;
}

const emptyMetadata: Metadata = { columns: [], foreignKeys: [], indexes: [], stats: null, ddl: "" };

/** DBeaver-style table object inspector built on the existing metadata IPC. */
export function DbTableDetailPanel({ sessionId, schema, table, kind = "table", engine, catalog, onClose, onStatus, onOpenData }: Props) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  const sqlEngine = asSqlEngine(engine);
  const [tab, setTab] = useState<DetailTab>("properties");
  const [metadata, setMetadata] = useState<Metadata>(emptyMetadata);
  const [data, setData] = useState<DbQueryResult | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMetadata = async () => {
    setLoading(true);
    setError(null);
    try {
      const [columns, foreignKeys, indexes, stats, ddl] = await Promise.all([
        dbDescribeTable(sessionId, schema, table, catalog).catch(() => []),
        dbListForeignKeys(sessionId, schema, table, catalog).catch(() => []),
        dbListIndexes(sessionId, schema, table).catch(() => []),
        dbTableStats(sessionId, schema, table).catch(() => null),
        dbObjectDdl(sessionId, schema, kind, table).catch(() => ""),
      ]);
      setMetadata({ columns, foreignKeys, indexes, stats, ddl });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  };

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const sql = selectStatement(sqlEngine, { schema, name: table }, [], 100);
      setData(await dbExecute(sessionId, sql));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    closeRef.current?.focus();
    void loadMetadata();
  }, [sessionId, schema, table, kind, catalog]);

  useEffect(() => {
    if (tab === "data" && data === null) void loadData();
  }, [tab]);

  const visibleRows = useMemo(() => {
    if (!data) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return data.rows;
    return data.rows.filter((row) => row.some((cell) => (cell ?? "NULL").toLowerCase().includes(needle)));
  }, [data, filter]);

  const copyDdl = async () => {
    await writeText(metadata.ddl);
    onStatus?.(t("dbObjects.copied"));
  };

  const renderProperties = () => (
    <div className="flex-1 min-h-0 overflow-auto taomni-scroll-y p-3 space-y-3">
      <section>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]" data-testid="db-detail-summary">
          <Summary label={t("dbObjects.detailSchema")} value={schema ?? "—"} />
          <Summary label={t("dbObjects.detailTable")} value={table} />
          {(metadata.stats?.rows[0] ?? []).map((value, index) => (
            <Summary key={metadata.stats?.columns[index]?.name ?? index} label={metadata.stats?.columns[index]?.name ?? ""} value={value ?? "NULL"} />
          ))}
        </div>
      </section>
      <MetadataTable title={t("dbObjects.detailColumns")} columns={[t("dbObjects.detailName"), t("dbObjects.detailType"), t("dbObjects.detailNullable"), t("dbObjects.detailDefault"), t("dbObjects.detailKey")]} rows={metadata.columns.map((column) => [column.name, column.type, column.nullable ? "YES" : "NO", column.default ?? "NULL", column.primaryKey ? "PRI" : ""])} />
      <MetadataTable title={t("dbObjects.detailIndexes")} columns={[t("dbObjects.detailName"), t("dbObjects.detailColumnsList"), t("dbObjects.detailUnique")]} rows={metadata.indexes.map((index) => [index.name, index.columns.join(", "), index.unique ? "YES" : "NO"])} />
      <MetadataTable title={t("dbObjects.detailForeignKeys")} columns={[t("dbObjects.detailName"), t("dbObjects.detailColumnsList"), t("dbObjects.detailReferences")]} rows={metadata.foreignKeys.map((key) => [key.name, key.columns.join(", "), `${key.referencedTable} (${key.referencedColumns.join(", ")})`])} />
      <section>
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-[12px] font-semibold flex-1">DDL</h3>
          <button type="button" className="taomni-btn h-6 px-2 text-[11px]" onClick={() => void copyDdl()} disabled={!metadata.ddl}><Copy className="w-3 h-3" /> {t("dbObjects.copy")}</button>
        </div>
        <pre data-testid="db-detail-ddl" className="m-0 p-2 rounded text-[11px] font-mono whitespace-pre-wrap" style={{ background: "var(--taomni-quick-bg)" }}>{metadata.ddl || "—"}</pre>
      </section>
    </div>
  );

  const renderData = () => (
    <div className="flex-1 min-h-0 flex flex-col p-3 gap-2">
      <div className="flex items-center gap-2 shrink-0">
        <input className="taomni-input h-7 flex-1 text-[12px]" placeholder={t("dbObjects.detailFilterRows")} value={filter} onChange={(event) => setFilter(event.target.value)} data-testid="db-detail-data-filter" />
        <button type="button" className="taomni-btn h-7 px-2 text-[11px]" onClick={() => void loadData()}><RefreshCw className="w-3 h-3" /> {t("dbObjects.refresh")}</button>
        {onOpenData && <button type="button" className="taomni-btn h-7 px-2 text-[11px]" onClick={onOpenData}>{t("dbObjects.detailOpenEditor")}</button>}
        <span className="text-[11px] text-[var(--taomni-text-muted)]">{visibleRows.length}/{data?.rows.length ?? 0}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto taomni-scroll-y border rounded" data-testid="db-detail-data-grid">
        {data ? <table className="w-full text-[11px] border-collapse"><thead><tr>{data.columns.map((column) => <th key={column.name} className="text-left px-2 py-1 sticky top-0" style={{ background: "var(--taomni-quick-bg)", borderBottom: "1px solid var(--taomni-divider)" }}>{column.name}</th>)}</tr></thead><tbody>{visibleRows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="px-2 py-1 font-mono align-top" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>{cell ?? <span className="text-[var(--taomni-text-muted)]">NULL</span>}</td>)}</tr>)}</tbody></table> : <div className="p-3 text-[12px] text-[var(--taomni-text-muted)]">{loading ? "Loading…" : t("dbObjects.noData")}</div>}
      </div>
    </div>
  );

  const renderDiagram = () => (
    <div className="flex-1 min-h-0 overflow-auto taomni-scroll-y p-4" data-testid="db-detail-diagram">
      <div className="flex items-start gap-8 min-w-max">
        <div className="w-64 rounded border shadow-sm" style={{ background: "var(--taomni-bg)" }}>
          <div className="px-3 py-2 font-semibold text-[12px] flex items-center gap-2" style={{ background: "var(--taomni-quick-bg)", borderBottom: "1px solid var(--taomni-divider)" }}><Database className="w-3.5 h-3.5" />{table}</div>
          {metadata.columns.map((column) => <div key={column.name} className="px-3 py-1 text-[11px] flex gap-2"><span className="w-4 text-[var(--taomni-text-muted)]">{column.primaryKey ? "#" : ""}</span><span className="flex-1">{column.name}</span><span className="text-[var(--taomni-text-muted)]">{column.type}</span></div>)}
        </div>
        {metadata.foreignKeys.length > 0 && <div className="pt-10 text-[12px] text-[var(--taomni-text-muted)]">{metadata.foreignKeys.map((key) => <div key={key.name} className="mb-3">── {key.name} → {key.referencedTable}</div>)}</div>}
      </div>
      {metadata.foreignKeys.length === 0 && <div className="mt-4 text-[12px] text-[var(--taomni-text-muted)]">{t("dbObjects.detailNoRelations")}</div>}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[950] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div role="dialog" aria-modal="true" aria-label={t("dbObjects.detailTitle", { name: table })} data-testid="db-table-detail-panel" className="w-[900px] max-w-[94vw] h-[min(720px,88vh)] flex flex-col rounded shadow-lg" style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }} onClick={(event) => event.stopPropagation()}>
        <div className="h-10 shrink-0 flex items-center gap-2 px-3" style={{ borderBottom: "1px solid var(--taomni-divider)" }}><Database className="w-4 h-4 text-[var(--taomni-accent)]" /><span className="font-semibold text-[13px] truncate flex-1">{table}</span><span className="text-[11px] text-[var(--taomni-text-muted)]">{schema ?? ""}</span><button ref={closeRef} type="button" className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={onClose} aria-label={t("common.close")}><X className="w-3.5 h-3.5" /></button></div>
        <div className="h-9 shrink-0 flex items-center gap-1 px-3" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>{(["properties", "data", "diagram"] as DetailTab[]).map((item) => <button key={item} type="button" className="h-7 px-3 rounded text-[12px]" style={{ background: tab === item ? "var(--taomni-selected)" : undefined }} onClick={() => setTab(item)} data-testid={`db-detail-tab-${item}`}>{t(`dbObjects.detailTab${item[0].toUpperCase()}${item.slice(1)}` as "dbObjects.detailTabProperties" | "dbObjects.detailTabData" | "dbObjects.detailTabDiagram")}</button>)}<button type="button" className="ml-auto h-7 px-2 rounded hover:bg-[var(--taomni-hover)]" onClick={() => { if (tab === "data") void loadData(); else void loadMetadata(); }} title={t("dbObjects.refresh")}><RefreshCw className="w-3.5 h-3.5" /></button></div>
        {error && <div className="px-3 py-1 text-[11px]" style={{ color: "#d9534f" }}>{error}</div>}
        {loading && <div className="px-3 py-1 text-[11px] text-[var(--taomni-text-muted)]">Loading…</div>}
        {tab === "properties" ? renderProperties() : tab === "data" ? renderData() : renderDiagram()}
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="flex gap-2"><span className="text-[var(--taomni-text-muted)]">{label}:</span><span className="font-mono truncate">{value}</span></div>;
}

function MetadataTable({ title, columns, rows }: { title: string; columns: string[]; rows: string[][] }) {
  return <section><h3 className="text-[12px] font-semibold mb-1">{title} ({rows.length})</h3>{rows.length === 0 ? <div className="text-[11px] text-[var(--taomni-text-muted)]">—</div> : <div className="overflow-auto border rounded"><table className="w-full text-[11px] border-collapse"><thead><tr>{columns.map((column) => <th key={column} className="text-left px-2 py-1" style={{ background: "var(--taomni-quick-bg)", borderBottom: "1px solid var(--taomni-divider)" }}>{column}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="px-2 py-1" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>{cell}</td>)}</tr>)}</tbody></table></div>}</section>;
}
