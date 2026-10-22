import { ChevronDown, ChevronRight, Columns3, Database, KeyRound, ListTree } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useT } from "../../lib/i18n";
import { asSqlEngine, categoriesForEngine, columnReference, qualifiedName, supportsIndexes, type ObjectKind } from "../../lib/sqlDialect";
import { useContextMenu } from "../ContextMenu";
import { useConfirmDialog, useTextInputDialog } from "../sidebar/ConfirmDialog";
import { type ObjectDetail } from "./DbObjectDetailDialog";
import { CATEGORY_META, catKey, COLUMN_CATEGORIES, dbKey, formatRowCount, objKey, TABLE_CATEGORIES } from "./schema/presentation";
import { SchemaTreeView } from "./schema/SchemaTreeView";
import { type ObjNodeState, type SchemaTreeProps, type SchemaTreeSelectedObject } from "./schema/types";
import { useSchemaActions } from "./schema/useSchemaActions";
import { useSchemaMetadata } from "./schema/useSchemaMetadata";

export function SchemaTree({
  sessionId,
  engine,
  onSelectionChange,
  onInsertTable,
  onQuickSelect,
  quickSelectLimit = 1000,
  catalog,
  databaseName,
  onInsertSql,
  onNewQuery,
  onSetDefaultSchema,
  activeSchema = null,
  onStatus,
  onSchemasLoaded,
  onSchemaLoaded,
  metadataCache,
}: SchemaTreeProps) {
  const t = useT();
  const sqlEngine = asSqlEngine(engine);
  const categories = categoriesForEngine(sqlEngine);
  const showIndexes = supportsIndexes(sqlEngine);
  const databaseRootName = databaseName?.trim() ?? "";
  const groupSchemasUnderDatabase =
    databaseRootName.length > 0 && (sqlEngine === "PostgreSQL" || sqlEngine === "PanWeiDB");
  const confirmDialog = useConfirmDialog();
  const inputDialog = useTextInputDialog();
  const [detail, setDetail] = useState<ObjectDetail | null>(null);
  const [tableDetail, setTableDetail] = useState<{ schema: string; table: string; kind: "table" | "view" | "materialized_view"; } | null>(null);
  const [databaseRootExpanded, setDatabaseRootExpanded] = useState(true);
  const [selectedObjects, setSelectedObjects] = useState<Record<string, SchemaTreeSelectedObject>>({});
  const [filterText, setFilterText] = useState("");
  const { show: openMenu, render: menu } = useContextMenu();
  const metadata = useSchemaMetadata({
    sessionId,
    catalog,
    metadataCache,
    onSchemasLoaded,
    onSchemaLoaded,
    onSetDefaultSchema,
    showIndexes,
  });

  const filterNeedle = filterText.trim().toLowerCase();
  const filterActive = filterNeedle.length > 0;
  const matchesFilter = useCallback(
    (...parts: Array<string | null | undefined>) =>
      !filterActive || parts.some((part) => part?.toLowerCase().includes(filterNeedle)),
    [filterActive, filterNeedle],
  );

  useEffect(() => {
    if (!filterActive) return;
    for (const db of metadata.schemas) {
      void metadata.ensureTables(db);
    }
  }, [metadata.ensureTables, filterActive, metadata.schemas]);

  const publishSelection = useCallback(
    (next: Record<string, SchemaTreeSelectedObject>) => {
      onSelectionChange?.(Object.values(next));
    },
    [onSelectionChange],
  );

  const selectObject = (
    event: ReactMouseEvent<HTMLButtonElement>,
    db: string,
    kind: ObjectKind,
    name: string,
  ) => {
    const key = objKey(db, kind, name);
    const multi = event.ctrlKey || event.metaKey || event.shiftKey;
    const next = multi ? { ...selectedObjects } : {};
    if (multi && next[key]) {
      delete next[key];
    } else {
      next[key] = { schema: db, name, kind };
    }
    setSelectedObjects(next);
    publishSelection(next);
  };

  /** Objects for a category folder (tables split out of the cached table list). */
  const objectsFor = (
    db: string,
    kind: ObjectKind,
  ): { name: string; rowCount?: number | null; owner?: string; }[] => {
    if (TABLE_CATEGORIES.includes(kind)) {
      return (metadata.tablesByDb[db] ?? [])
        .filter((t) => t.kind === kind)
        .map((t) => ({ name: t.name, rowCount: t.rowCount }));
    }
    return (metadata.objectsByCat[catKey(db, kind)] ?? []).map((o) => ({ name: o.name, owner: o.owner }));
  };

  const filteredObjectsFor = (
    db: string,
    kind: ObjectKind,
  ): { name: string; rowCount?: number | null; owner?: string; }[] =>
    objectsFor(db, kind).filter((obj) => matchesFilter(obj.name, obj.owner));

  const categoryVisible = (db: string, kind: ObjectKind): boolean =>
    !filterActive || filteredObjectsFor(db, kind).length > 0;

  const databaseVisible = (db: string): boolean =>
    !filterActive || matchesFilter(db) || categories.some((kind) => categoryVisible(db, kind));

  const databaseRootMatchesFilter = filterActive && matchesFilter(databaseRootName);

  const visibleSchemas = useMemo(
    () => metadata.schemas.filter((db) => databaseRootMatchesFilter || databaseVisible(db)),
    [databaseRootMatchesFilter, databaseVisible, metadata.schemas],
  );

  const categoryCount = (db: string, kind: ObjectKind): number | null => {
    if (filterActive) return filteredObjectsFor(db, kind).length;
    if (TABLE_CATEGORIES.includes(kind)) {
      return metadata.tablesByDb[db] ? metadata.tablesByDb[db].filter((t) => t.kind === kind).length : null;
    }
    const list = metadata.objectsByCat[catKey(db, kind)];
    return list ? list.length : null;
  };
  const actions = useSchemaActions({
    catalog,
    onStatus,
    t,
    sessionId,
    metadata,
    sqlEngine,
    onInsertSql,
    confirmDialog,
    quickSelectLimit,
    setDetail,
    setTableDetail,
    inputDialog,
    onNewQuery,
    categories,
    onSetDefaultSchema,
    onQuickSelect,
    showIndexes,
    onInsertTable,
    selectedObjects,
    openMenu,
    setSelectedObjects,
    publishSelection,
  });

  // (object/column/index menus defined above)

  const renderObjects = (db: string, kind: ObjectKind) => {
    const expandable = COLUMN_CATEGORIES.includes(kind);
    const items = filterActive ? filteredObjectsFor(db, kind) : objectsFor(db, kind);
    const { Icon, color } = CATEGORY_META[kind];
    if (items.length === 0) {
      return (
        <div className="px-2 py-0.5 text-[var(--taomni-text-muted)]" style={{ paddingLeft: 36 }}>
          —
        </div>
      );
    }
    return items.map((obj) => {
      const key = objKey(db, kind, obj.name);
      const st = metadata.objState[key];
      const isSel = selectedObjects[key] !== undefined;
      return (
        <div key={obj.name}>
          <button
            type="button"
            className="taomni-tree-row w-full text-left"
            style={{ paddingLeft: 34, background: isSel ? "var(--taomni-selected)" : undefined }}
            aria-pressed={isSel}
            data-testid="schema-tree-object"
            data-schema={db}
            data-object-name={obj.name}
            data-object-kind={kind}
            onClick={(event) => {
              selectObject(event, db, kind, obj.name);
              if (expandable && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                void metadata.toggleObject(db, kind, obj.name);
              }
            }}
            onDoubleClick={() => onInsertTable?.(qualifiedName(sqlEngine, actions.target(db, obj.name)))}
            onContextMenu={(event) => actions.openObjectContextMenu(event, db, kind, obj.name, obj.owner)}
            title={obj.name}
          >
            {expandable ? (
              st?.expanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )
            ) : (
              <span className="w-3 h-3 inline-block" />
            )}
            <Icon className="w-3.5 h-3.5" style={{ color }} />
            <span className="flex-1 truncate">{obj.name}</span>
            {typeof obj.rowCount === "number" && obj.rowCount >= 0 && (
              <span
                className="text-[10px] rounded px-1"
                style={{ background: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
                title={`${obj.rowCount.toLocaleString()} row(s)`}
              >
                {formatRowCount(obj.rowCount)}
              </span>
            )}
          </button>
          {expandable && st?.expanded && renderObjectChildren(db, obj.name, st)}
        </div>
      );
    });
  };

  const renderObjectChildren = (db: string, table: string, st: ObjNodeState) => (
    <div>
      {st.loading && (
        <div className="px-2 py-0.5 text-[var(--taomni-text-muted)]" style={{ paddingLeft: 50 }}>
          Loading…
        </div>
      )}
      {st.columns?.map((col) => (
        <button
          key={col.name}
          type="button"
          className="taomni-tree-row w-full text-left"
          style={{ paddingLeft: 50 }}
          onContextMenu={(e) => openMenu(e, actions.columnMenu(db, table, col))}
          onDoubleClick={() => onInsertTable?.(columnReference(sqlEngine, col.name))}
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
        </button>
      ))}
      {(st.indexes ?? []).length > 0 && (
        <div
          className="px-2 py-0.5 text-[10px] text-[var(--taomni-text-muted)] flex items-center gap-1"
          style={{ paddingLeft: 50 }}
        >
          <ListTree className="w-3 h-3" /> Indexes
        </div>
      )}
      {st.indexes?.map((idx) => (
        <button
          key={idx.name}
          type="button"
          className="taomni-tree-row w-full text-left"
          style={{ paddingLeft: 64 }}
          onContextMenu={(e) => openMenu(e, actions.indexMenu(db, table, idx))}
          title={`${idx.columns.join(", ")}${idx.unique ? " (unique)" : ""}`}
        >
          <ListTree className="w-3 h-3 text-[var(--taomni-text-muted)]" />
          <span className="flex-1 truncate">{idx.name}</span>
        </button>
      ))}
    </div>
  );

  const renderSchemaRows = () => (
    visibleSchemas.map((db) => {
      const isActive = activeSchema === db;
      const isExpanded = metadata.expandedDb[dbKey(db)] || filterActive;
      return (
        <div key={db}>
          <div
            className="taomni-tree-row w-full text-left"
            style={{ background: isActive ? "var(--taomni-selected)" : undefined }}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e, actions.databaseMenu(db));
            }}
            data-testid={`schema-tree-db-${db}`}
            data-active={isActive ? "true" : "false"}
          >
            <button
              type="button"
              className="h-full inline-flex items-center justify-center shrink-0 rounded hover:bg-[var(--taomni-hover)]"
              aria-label={isExpanded ? `Collapse ${db}` : `Expand ${db}`}
              title={isExpanded ? `Collapse ${db}` : `Expand ${db}`}
              onClick={(e) => {
                e.stopPropagation();
                metadata.toggleDb(db);
              }}
            >
              {isExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
            </button>
            <button
              type="button"
              className="flex-1 min-w-0 inline-flex items-center gap-1 text-left"
              onClick={() => metadata.selectDatabase(db)}
              title={t("dbObjects.setDefault")}
              aria-pressed={isActive}
              data-testid={`schema-tree-db-name-${db}`}
            >
              <Database className="w-3.5 h-3.5 text-[var(--taomni-accent)] shrink-0" />
              <span className="flex-1 truncate">{db}</span>
            </button>
          </div>
          {isExpanded &&
            categories.filter((kind) => categoryVisible(db, kind)).map((kind) => {
              const meta = CATEGORY_META[kind];
              const CatIcon = meta.Icon;
              const ckey = catKey(db, kind);
              const count = categoryCount(db, kind);
              return (
                <div key={kind}>
                  <button
                    type="button"
                    className="taomni-tree-row w-full text-left"
                    style={{ paddingLeft: 18 }}
                    onClick={() => metadata.toggleCategory(db, kind)}
                    onContextMenu={(e) => openMenu(e, actions.categoryMenu(db, kind))}
                  >
                    {metadata.expandedCat[ckey] || filterActive ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                    <CatIcon className="w-3.5 h-3.5" style={{ color: meta.color }} />
                    <span className="flex-1 truncate">{meta.label}</span>
                    {count !== null && (
                      <span className="text-[10px] text-[var(--taomni-text-muted)]">{count}</span>
                    )}
                  </button>
                  {(metadata.expandedCat[ckey] || filterActive) && renderObjects(db, kind)}
                </div>
              );
            })}
        </div>
      );
    })
  );

  return <SchemaTreeView
    engine={engine}
    metadata={metadata}
    filterText={filterText}
    t={t}
    setFilterText={setFilterText}
    filterActive={filterActive}
    visibleSchemas={visibleSchemas}
    databaseRootMatchesFilter={databaseRootMatchesFilter}
    groupSchemasUnderDatabase={groupSchemasUnderDatabase}
    setDatabaseRootExpanded={setDatabaseRootExpanded}
    databaseRootName={databaseRootName}
    databaseRootExpanded={databaseRootExpanded}
    renderSchemaRows={renderSchemaRows}
    menu={menu}
    confirmDialog={confirmDialog}
    inputDialog={inputDialog}
    detail={detail}
    setDetail={setDetail}
    onStatus={onStatus}
    tableDetail={tableDetail}
    sessionId={sessionId}
    catalog={catalog}
    setTableDetail={setTableDetail}
    onQuickSelect={onQuickSelect}
  />;
}

export { type SchemaTreeSelectedObject } from "./schema/types";
