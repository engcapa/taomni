import { ChevronDown, ChevronRight, Database, RefreshCw, Search } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { useConfirmDialog, useTextInputDialog } from "../../sidebar/ConfirmDialog";
import { DbObjectDetailDialog, type ObjectDetail } from "../DbObjectDetailDialog";
import { DbTableDetailPanel } from "../DbTableDetailPanel";
import { useSchemaMetadata } from "./useSchemaMetadata";

export interface SchemaTreeViewProps {
  engine: string;
  metadata: ReturnType<typeof useSchemaMetadata>;
  filterText: string;
  t: ReturnType<typeof useT>;
  setFilterText: import("react").Dispatch<import("react").SetStateAction<string>>;
  filterActive: boolean;
  visibleSchemas: string[];
  databaseRootMatchesFilter: boolean;
  groupSchemasUnderDatabase: boolean;
  setDatabaseRootExpanded: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  databaseRootName: string;
  databaseRootExpanded: boolean;
  renderSchemaRows: () => import("react").JSX.Element[];
  menu: import("react").JSX.Element | null;
  confirmDialog: ReturnType<typeof useConfirmDialog>;
  inputDialog: ReturnType<typeof useTextInputDialog>;
  detail: ObjectDetail | null;
  setDetail: import("react").Dispatch<import("react").SetStateAction<ObjectDetail | null>>;
  onStatus: ((message: string) => void) | undefined;
  tableDetail: { schema: string; table: string; kind: "table" | "view" | "materialized_view"; } | null;
  sessionId: string;
  catalog: string | null | undefined;
  setTableDetail: import("react").Dispatch<import("react").SetStateAction<{ schema: string; table: string; kind: "table" | "view" | "materialized_view"; } | null>>;
  onQuickSelect: ((schema: string | null, table: string) => void) | undefined;
}

export function SchemaTreeView(props: SchemaTreeViewProps) {
  const {
    engine,
    metadata,
    filterText,
    t,
    setFilterText,
    filterActive,
    visibleSchemas,
    databaseRootMatchesFilter,
    groupSchemasUnderDatabase,
    setDatabaseRootExpanded,
    databaseRootName,
    databaseRootExpanded,
    renderSchemaRows,
    menu,
    confirmDialog,
    inputDialog,
    detail,
    setDetail,
    onStatus,
    tableDetail,
    sessionId,
    catalog,
    setTableDetail,
    onQuickSelect,
  } = props;
  return ((
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
          onClick={metadata.refreshAll}
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      <div
        className="h-7 flex items-center px-1.5 shrink-0"
        style={{
          background: "var(--taomni-quick-bg)",
          borderBottom: "1px solid var(--taomni-divider)",
        }}
      >
        <div className="relative flex-1">
          <Search className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)] pointer-events-none" />
          <input
            type="search"
            className="taomni-input h-5 w-full text-[11px]"
            style={{ paddingLeft: 22 }}
            value={filterText}
            placeholder={t("dbObjects.filterPlaceholder")}
            aria-label={t("dbObjects.filterLabel")}
            data-testid="schema-tree-filter"
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilterText("");
            }}
          />
        </div>
      </div>

      <div
        className="flex-1 min-h-0 overflow-auto taomni-scroll-y py-1 text-[12px]"
        style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
      >
        {metadata.error && (
          <div className="px-2 py-1 text-[11px]" style={{ color: "#d9534f" }}>
            {metadata.error}
          </div>
        )}
        {metadata.loadingSchemas && metadata.schemas.length === 0 && (
          <div className="px-2 py-1 text-[var(--taomni-text-muted)]">Loading…</div>
        )}
        {filterActive && !visibleSchemas.length && !databaseRootMatchesFilter && (
          <div className="px-2 py-1 text-[var(--taomni-text-muted)]">{t("dbObjects.noFilterMatches")}</div>
        )}
        {groupSchemasUnderDatabase ? (
          <>
            <button
              type="button"
              className="taomni-tree-row w-full text-left"
              onClick={() => setDatabaseRootExpanded((value) => !value)}
              title={databaseRootName}
            >
              {databaseRootExpanded || filterActive ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <Database className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
              <span className="flex-1 truncate">{databaseRootName}</span>
              <span className="text-[10px] text-[var(--taomni-text-muted)]">{metadata.schemas.length}</span>
            </button>
            {(databaseRootExpanded || filterActive) && (
              <div style={{ paddingLeft: 14 }}>{renderSchemaRows()}</div>
            )}
          </>
        ) : (
          renderSchemaRows()
        )}
      </div>
      {menu}
      {confirmDialog.render}
      {inputDialog.render}
      {detail && (
        <DbObjectDetailDialog detail={detail} onClose={() => setDetail(null)} onStatus={onStatus} />
      )}
      {tableDetail && (
        <DbTableDetailPanel
          sessionId={sessionId}
          schema={tableDetail.schema}
          table={tableDetail.table}
          kind={tableDetail.kind}
          engine={engine}
          catalog={catalog}
          onClose={() => setTableDetail(null)}
          onStatus={onStatus}
          onOpenData={() => {
            onQuickSelect?.(tableDetail.schema, tableDetail.table);
            setTableDetail(null);
          }}
        />
      )}
    </div>
  ));
}
