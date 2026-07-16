import { useEffect, useState, useCallback, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
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
  Boxes,
  Braces,
  SquareFunction,
  Zap,
  CalendarClock,
  ListOrdered,
  BookText,
  Search,
  X,
} from "lucide-react";
import {
  dbListObjects,
  dbListIndexes,
  dbExecute,
  dbObjectDdl,
  dbTableStats,
  type DbTable,
  type DbObject,
  type DbColumnDescription,
  type DbIndex,
  type DbQueryResult,
} from "../../lib/ipc";
import { createDbMetadataCache, type DbMetadataCache } from "../../lib/dbMetadataCache";
import {
  asSqlEngine,
  categoriesForEngine,
  supportsIndexes,
  supportsInlineEdit,
  actionMode,
  selectStatement,
  insertStatement,
  updateStatement,
  deleteStatement,
  truncateStatement,
  renameTableStatement,
  dropStatement,
  dropColumnStatement,
  alterColumnStatement,
  dropIndexStatement,
  dropDatabaseStatement,
  renameDatabaseStatement,
  dropTriggerStatement,
  disableTriggerStatement,
  callStatement,
  functionCallStatement,
  createTemplate,
  columnReference,
  columnCondition,
  type ObjectKind,
  type ObjectTarget,
  type DialectAction,
} from "../../lib/sqlDialect";
import { useT } from "../../lib/i18n";
import { writeText } from "../../lib/clipboard";
import { useConfirmDialog, useTextInputDialog } from "../sidebar/ConfirmDialog";
import { DbObjectDetailDialog, type ObjectDetail } from "./DbObjectDetailDialog";
import { useContextMenu, type MenuItem } from "../ContextMenu";

interface SchemaTreeProps {
  sessionId: string;
  engine: string;
  /** Called when one or more tree objects are selected. */
  onSelectionChange?: (objects: SchemaTreeSelectedObject[]) => void;
  /** Called when a table is double-clicked — inserts its name into the editor. */
  onInsertTable?: (table: string) => void;
  /** "Select top N rows" context action. */
  onQuickSelect?: (schema: string | null, table: string) => void;
  quickSelectLimit?: number;
  /** Presto catalog, needed to fully-qualify object names. */
  catalog?: string | null;
  /** Connection database name for engines where schemas live under a database. */
  databaseName?: string | null;
  /** Insert a full statement into a new query panel (for review/run). */
  onInsertSql?: (sql: string) => void;
  /** Open a fresh, empty query panel. */
  onNewQuery?: () => void;
  /** Make a schema the session default. */
  onSetDefaultSchema?: (schema: string) => void;
  /** Currently active schema/database (highlight + toolbar sync). */
  activeSchema?: string | null;
  /** Surface a transient status message. */
  onStatus?: (message: string) => void;
  /** Bubble up schema names for the editor toolbar selector. */
  onSchemasLoaded?: (schemas: string[]) => void;
  /** Bubble up the loaded schema → tables/columns for editor autocomplete. */
  onSchemaLoaded?: (tables: Map<string, string[]>) => void;
  /** Shared lazy metadata cache used by both schema tree and SQL editor. */
  metadataCache?: DbMetadataCache;
}

export interface SchemaTreeSelectedObject {
  schema: string | null;
  name: string;
  kind: ObjectKind;
}

const CATEGORY_META: Record<
  ObjectKind,
  { label: string; Icon: typeof Table2; color: string }
> = {
  table: { label: "Tables", Icon: Table2, color: "#3b7ac2" },
  view: { label: "Views", Icon: Eye, color: "#c97a23" },
  materialized_view: { label: "Materialized Views", Icon: Boxes, color: "#c97a23" },
  procedure: { label: "Procedures", Icon: Braces, color: "#8a63d2" },
  function: { label: "Functions", Icon: SquareFunction, color: "#8a63d2" },
  trigger: { label: "Triggers", Icon: Zap, color: "#d9a13b" },
  event: { label: "Events", Icon: CalendarClock, color: "#4aa564" },
  sequence: { label: "Sequences", Icon: ListOrdered, color: "#4aa564" },
  dictionary: { label: "Dictionaries", Icon: BookText, color: "#4aa564" },
};

/** Categories whose objects come from `db_list_tables` (split by `kind`). */
const TABLE_CATEGORIES: ObjectKind[] = ["table", "view", "materialized_view"];

/** Categories whose objects can expand to show their columns. */
const COLUMN_CATEGORIES: ObjectKind[] = ["table", "view", "materialized_view"];

const SELECTABLE_OBJECT_KINDS = new Set<ObjectKind>(TABLE_CATEGORIES);

const dbKey = (db: string) => db;
const catKey = (db: string, kind: ObjectKind) => `${db}::${kind}`;
const objKey = (db: string, kind: ObjectKind, name: string) => `${db}::${kind}::${name}`;

function formatRowCount(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

interface ObjNodeState {
  expanded: boolean;
  columns?: DbColumnDescription[];
  indexes?: DbIndex[];
  loading?: boolean;
}

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

  const [schemas, setSchemas] = useState<string[]>([]);
  const [databaseRootExpanded, setDatabaseRootExpanded] = useState(true);
  const [expandedDb, setExpandedDb] = useState<Record<string, boolean>>({});
  const [expandedCat, setExpandedCat] = useState<Record<string, boolean>>({});
  const [tablesByDb, setTablesByDb] = useState<Record<string, DbTable[]>>({});
  const [objectsByCat, setObjectsByCat] = useState<Record<string, DbObject[]>>({});
  const [objState, setObjState] = useState<Record<string, ObjNodeState>>({});
  const [selectedObjects, setSelectedObjects] = useState<Record<string, SchemaTreeSelectedObject>>({});
  const [error, setError] = useState<string | null>(null);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [filterText, setFilterText] = useState("");
  const loadingTablesRef = useRef(new Set<string>());
  const { show: openMenu, render: menu } = useContextMenu();
  const ownedMetadataCache = useMemo(
    () => createDbMetadataCache({ sessionId, defaultCatalog: catalog }),
    [catalog, sessionId],
  );
  const cache = metadataCache ?? ownedMetadataCache;

  const loadSchemas = useCallback(async () => {
    setLoadingSchemas(true);
    setError(null);
    try {
      const names = await cache.listSchemas(catalog);
      setSchemas(names);
      onSchemasLoaded?.(names);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingSchemas(false);
    }
  }, [cache, catalog, onSchemasLoaded]);

  useEffect(() => {
    void loadSchemas();
  }, [loadSchemas]);

  const ensureTables = useCallback(
    async (db: string) => {
      if (tablesByDb[db] || loadingTablesRef.current.has(db)) return;
      loadingTablesRef.current.add(db);
      try {
        const list = await cache.listTables(db, catalog);
        setTablesByDb((prev) => ({ ...prev, [db]: list }));
        onSchemaLoaded?.(new Map(list.map((t) => [t.name, [] as string[]])));
      } catch (err) {
        setError(String(err));
        setTablesByDb((prev) => ({ ...prev, [db]: prev[db] ?? [] }));
      } finally {
        loadingTablesRef.current.delete(db);
      }
    },
    [cache, catalog, tablesByDb, onSchemaLoaded],
  );

  const ensureObjects = useCallback(
    async (db: string, kind: ObjectKind) => {
      const key = catKey(db, kind);
      if (objectsByCat[key]) return;
      try {
        const list = await dbListObjects(sessionId, db, kind);
        setObjectsByCat((prev) => ({ ...prev, [key]: list }));
      } catch (err) {
        setError(String(err));
      }
    },
    [sessionId, objectsByCat],
  );

  const toggleDb = (db: string) => {
    const next = !expandedDb[db];
    setExpandedDb((prev) => ({ ...prev, [db]: next }));
    // Eagerly load tables so the Tables/Views folder counts appear at once.
    if (next) void ensureTables(db);
  };

  /** Clicking the database/schema name makes it the session default (USE). */
  const selectDatabase = (db: string) => {
    onSetDefaultSchema?.(db);
    // Expand so the user can browse objects in the newly active database.
    if (!expandedDb[db]) {
      setExpandedDb((prev) => ({ ...prev, [db]: true }));
      void ensureTables(db);
    }
  };

  const toggleCategory = (db: string, kind: ObjectKind) => {
    const key = catKey(db, kind);
    const next = !expandedCat[key];
    setExpandedCat((prev) => ({ ...prev, [key]: next }));
    if (next) {
      if (TABLE_CATEGORIES.includes(kind)) void ensureTables(db);
      else void ensureObjects(db, kind);
    }
  };

  const toggleObject = async (db: string, kind: ObjectKind, name: string) => {
    const key = objKey(db, kind, name);
    const current = objState[key];
    const expanded = !current?.expanded;
    setObjState((prev) => ({ ...prev, [key]: { ...prev[key], expanded } }));
    if (expanded && !current?.columns) {
      setObjState((prev) => ({ ...prev, [key]: { ...prev[key], expanded, loading: true } }));
      try {
        const [columns, indexes] = await Promise.all([
          cache.describeTable(db, name, catalog),
          showIndexes
            ? dbListIndexes(sessionId, db, name).catch(() => [] as DbIndex[])
            : Promise.resolve([] as DbIndex[]),
        ]);
        setObjState((prev) => ({
          ...prev,
          [key]: { expanded: true, columns, indexes, loading: false },
        }));
        onSchemaLoaded?.(new Map([[name, columns.map((col) => col.name)]]));
      } catch (err) {
        setError(String(err));
        setObjState((prev) => ({ ...prev, [key]: { expanded: true, loading: false } }));
      }
    }
  };

  const filterNeedle = filterText.trim().toLowerCase();
  const filterActive = filterNeedle.length > 0;
  const matchesFilter = useCallback(
    (...parts: Array<string | null | undefined>) =>
      !filterActive || parts.some((part) => part?.toLowerCase().includes(filterNeedle)),
    [filterActive, filterNeedle],
  );

  useEffect(() => {
    if (!filterActive) return;
    for (const db of schemas) {
      void ensureTables(db);
    }
  }, [ensureTables, filterActive, schemas]);

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

  const refreshAll = () => {
    cache.clearAll();
    setTablesByDb({});
    setObjectsByCat({});
    setObjState({});
    void loadSchemas();
  };

  /** Objects for a category folder (tables split out of the cached table list). */
  const objectsFor = (
    db: string,
    kind: ObjectKind,
  ): { name: string; rowCount?: number | null; owner?: string }[] => {
    if (TABLE_CATEGORIES.includes(kind)) {
      return (tablesByDb[db] ?? [])
        .filter((t) => t.kind === kind)
        .map((t) => ({ name: t.name, rowCount: t.rowCount }));
    }
    return (objectsByCat[catKey(db, kind)] ?? []).map((o) => ({ name: o.name, owner: o.owner }));
  };

  const filteredObjectsFor = (
    db: string,
    kind: ObjectKind,
  ): { name: string; rowCount?: number | null; owner?: string }[] =>
    objectsFor(db, kind).filter((obj) => matchesFilter(obj.name, obj.owner));

  const categoryVisible = (db: string, kind: ObjectKind): boolean =>
    !filterActive || filteredObjectsFor(db, kind).length > 0;

  const databaseVisible = (db: string): boolean =>
    !filterActive || matchesFilter(db) || categories.some((kind) => categoryVisible(db, kind));

  const databaseRootMatchesFilter = filterActive && matchesFilter(databaseRootName);

  const visibleSchemas = useMemo(
    () => schemas.filter((db) => databaseRootMatchesFilter || databaseVisible(db)),
    [databaseRootMatchesFilter, databaseVisible, schemas],
  );

  const categoryCount = (db: string, kind: ObjectKind): number | null => {
    if (filterActive) return filteredObjectsFor(db, kind).length;
    if (TABLE_CATEGORIES.includes(kind)) {
      return tablesByDb[db] ? tablesByDb[db].filter((t) => t.kind === kind).length : null;
    }
    const list = objectsByCat[catKey(db, kind)];
    return list ? list.length : null;
  };

  const target = (db: string | null, name: string): ObjectTarget => ({ catalog, schema: db, name });

  const copy = async (text: string) => {
    await writeText(text);
    onStatus?.(t("dbObjects.copied"));
  };

  const refreshAfter = useCallback(
    async (db: string, kind: ObjectKind) => {
      if (TABLE_CATEGORIES.includes(kind)) {
        try {
          cache.invalidate({ catalog, schema: db });
          const list = await cache.listTables(db, catalog);
          setTablesByDb((prev) => ({ ...prev, [db]: list }));
        } catch {
          /* surfaced elsewhere */
        }
      } else {
        try {
          const list = await dbListObjects(sessionId, db, kind);
          setObjectsByCat((prev) => ({ ...prev, [catKey(db, kind)]: list }));
        } catch {
          /* ignore */
        }
      }
    },
    [cache, catalog, sessionId],
  );

  const runExec = async (sql: string, db: string, kind: ObjectKind) => {
    try {
      await dbExecute(sessionId, sql);
      onStatus?.(t("dbObjects.executed", { sql }));
      cache.invalidate({ catalog, schema: db });
      setObjState((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${db}::`)) delete next[key];
        }
        return next;
      });
      await refreshAfter(db, kind);
    } catch (e) {
      setError(String(e));
      onStatus?.(t("dbObjects.failed", { error: String(e) }));
    }
  };

  /** Either execute (behind a confirm) or emit to the editor, per engine policy. */
  const applyMutation = async (
    action: DialectAction,
    sql: string,
    confirmMessage: string,
    db: string,
    kind: ObjectKind,
    danger = true,
  ) => {
    const mode = actionMode(sqlEngine, action);
    if (mode === "disabled") return;
    if (mode === "editor") {
      onInsertSql?.(sql);
      onStatus?.(t("dbObjects.insertedToEditor"));
      return;
    }
    const ok = await confirmDialog.confirm({ message: confirmMessage, danger });
    if (ok) await runExec(sql, db, kind);
  };

  const getColumns = async (db: string | null, name: string): Promise<DbColumnDescription[]> => {
    const keyDb = db ?? "";
    const cached =
      objState[objKey(keyDb, "table", name)]?.columns ??
      objState[objKey(keyDb, "view", name)]?.columns ??
      objState[objKey(keyDb, "materialized_view", name)]?.columns;
    if (cached) return cached;
    return cache.describeTable(db, name, catalog).catch(() => [] as DbColumnDescription[]);
  };

  const insertDml = async (db: string, name: string, type: "select" | "insert" | "update" | "delete") => {
    const cols = await getColumns(db, name);
    const names = cols.map((c) => c.name);
    const pks = cols.filter((c) => c.primaryKey).map((c) => c.name);
    const tgt = target(db, name);
    const sql =
      type === "select"
        ? selectStatement(sqlEngine, tgt, names, quickSelectLimit)
        : type === "insert"
          ? insertStatement(sqlEngine, tgt, names)
          : type === "update"
            ? updateStatement(sqlEngine, tgt, names, pks)
            : deleteStatement(sqlEngine, tgt, pks, names);
    onInsertSql?.(sql);
  };

  const showDdl = async (db: string, kind: ObjectKind, name: string) => {
    try {
      const sql = await dbObjectDdl(sessionId, db, kind, name);
      setDetail({ kind: "ddl", title: t("dbObjects.ddlTitle", { name }), sql });
    } catch (e) {
      setError(String(e));
      onStatus?.(t("dbObjects.failed", { error: String(e) }));
    }
  };

  const objectDisplayName = (object: SchemaTreeSelectedObject): string => {
    const parts = [];
    if (catalog) parts.push(catalog);
    if (object.schema) parts.push(object.schema);
    parts.push(object.name);
    return parts.join(".");
  };

  const selectedDdlText = async (objects: SchemaTreeSelectedObject[]): Promise<string> => {
    const parts = await Promise.all(
      objects.map(async (object) => {
        const heading = `-- ${kindLabel(object.kind)} ${objectDisplayName(object)}`;
        try {
          const ddl = await dbObjectDdl(sessionId, object.schema, object.kind, object.name);
          return `${heading}\n${ddl}`;
        } catch (error) {
          return `${heading}\n-- ${t("dbObjects.failed", { error: String(error) })}`;
        }
      }),
    );
    return parts.join("\n\n");
  };

  const showSelectedDdl = async (objects: SchemaTreeSelectedObject[]) => {
    const sql = await selectedDdlText(objects);
    setDetail({
      kind: "ddl",
      title: t("dbObjects.selectedDdlTitle", { count: objects.length }),
      sql,
    });
  };

  const insertSelectedDdl = async (objects: SchemaTreeSelectedObject[]) => {
    const sql = await selectedDdlText(objects);
    onInsertSql?.(sql);
    onStatus?.(t("dbObjects.insertedToEditor"));
  };

  const insertSelectedSelects = async (objects: SchemaTreeSelectedObject[]) => {
    const statements = await Promise.all(
      objects.map(async (object) => {
        const cols = await cache.describeTable(object.schema, object.name, catalog).catch(() => [] as DbColumnDescription[]);
        return selectStatement(sqlEngine, target(object.schema, object.name), cols.map((col) => col.name), quickSelectLimit);
      }),
    );
    onInsertSql?.(statements.join("\n\n"));
    onStatus?.(t("dbObjects.insertedToEditor"));
  };

  const showStats = async (db: string, name: string) => {
    try {
      const result = await dbTableStats(sessionId, db, name);
      setDetail({ kind: "result", title: t("dbObjects.statsTitle", { name }), result });
    } catch (e) {
      setError(String(e));
      onStatus?.(t("dbObjects.failed", { error: String(e) }));
    }
  };

  const indexResult = (rows: DbIndex[]): DbQueryResult => ({
    columns: [
      { name: "Index", type: "text" },
      { name: "Columns", type: "text" },
      { name: "Unique", type: "text" },
    ],
    rows: rows.map((idx) => [idx.name, idx.columns.join(", "), idx.unique ? "YES" : "NO"]),
    rowsAffected: 0,
    durationMs: 0,
    warnings: [],
  });

  const showIndexList = async (db: string, table: string) => {
    try {
      const rows = await dbListIndexes(sessionId, db, table);
      setDetail({ kind: "result", title: t("dbObjects.indexTitle", { name: table }), result: indexResult(rows) });
    } catch (e) {
      setError(String(e));
    }
  };

  const sep: MenuItem = { label: "", separator: true };

  const kindLabel = (kind: ObjectKind): string =>
    ({
      table: t("dbObjects.kindTable"),
      view: t("dbObjects.kindView"),
      materialized_view: t("dbObjects.kindMaterializedView"),
      procedure: t("dbObjects.kindProcedure"),
      function: t("dbObjects.kindFunction"),
      trigger: t("dbObjects.kindTrigger"),
      event: t("dbObjects.kindEvent"),
      sequence: t("dbObjects.kindSequence"),
      dictionary: t("dbObjects.kindDictionary"),
    })[kind];

  const renameDatabase = async (db: string) => {
    const mode = actionMode(sqlEngine, "renameDatabase");
    if (mode === "disabled") return;
    const name = await inputDialog.promptText({
      title: t("dbObjects.renameDbTitle", { name: db }),
      label: t("dbObjects.renameLabel"),
      initialValue: db,
    });
    if (!name || name === db) return;
    const sql = renameDatabaseStatement(sqlEngine, db, name);
    if (mode === "editor") {
      onInsertSql?.(sql);
      onStatus?.(t("dbObjects.insertedToEditor"));
      return;
    }
    await runExec(sql, db, "table");
  };

  const renameTable = async (db: string, kind: ObjectKind, name: string) => {
    const mode = actionMode(sqlEngine, "rename");
    const newName = await inputDialog.promptText({
      title: t("dbObjects.renameTitle", { name }),
      label: t("dbObjects.renameLabel"),
      initialValue: name,
    });
    if (!newName || newName === name) return;
    const sql = renameTableStatement(sqlEngine, target(db, name), newName);
    if (mode === "editor") {
      onInsertSql?.(sql);
      onStatus?.(t("dbObjects.insertedToEditor"));
      return;
    }
    await runExec(sql, db, kind);
  };

  const modifyColumn = async (db: string, table: string, col: DbColumnDescription) => {
    const mode = actionMode(sqlEngine, "alterColumn");
    const newType = await inputDialog.promptText({
      title: t("dbObjects.modifyColumnTitle", { column: col.name }),
      label: t("dbObjects.modifyColumnLabel"),
      initialValue: col.type,
    });
    if (!newType) return;
    const sql = alterColumnStatement(sqlEngine, target(db, table), {
      oldName: col.name,
      type: newType,
      nullable: col.nullable,
    });
    if (mode === "editor") {
      onInsertSql?.(sql);
      onStatus?.(t("dbObjects.insertedToEditor"));
      return;
    }
    await runExec(sql, db, "table");
  };

  const databaseMenu = (db: string): MenuItem[] => [
    { label: t("dbObjects.newQuery"), onClick: () => onNewQuery?.() },
    {
      label: t("dbObjects.newObject"),
      children: categories.map((kind) => ({
        label: kindLabel(kind),
        onClick: () => onInsertSql?.(createTemplate(sqlEngine, kind, db)),
      })),
    },
    { label: t("dbObjects.setDefault"), onClick: () => onSetDefaultSchema?.(db) },
    sep,
    {
      label: t("dbObjects.renameDatabase"),
      disabled: actionMode(sqlEngine, "renameDatabase") === "disabled",
      onClick: () => void renameDatabase(db),
    },
    sep,
    {
      label: t("dbObjects.dropDatabase"),
      danger: true,
      onClick: () =>
        void applyMutation(
          "dropDatabase",
          dropDatabaseStatement(sqlEngine, db),
          t("dbObjects.dropDatabaseConfirm", { name: db }),
          db,
          "table",
        ),
    },
  ];

  const categoryMenu = (db: string, kind: ObjectKind): MenuItem[] => [
    { label: t("dbObjects.refresh"), onClick: () => void refreshAfter(db, kind) },
    {
      label: t("dbObjects.newObject"),
      onClick: () => onInsertSql?.(createTemplate(sqlEngine, kind, db)),
    },
  ];

  const modifyFromDdl = async (db: string, kind: ObjectKind, name: string) => {
    try {
      const sql = await dbObjectDdl(sessionId, db, kind, name);
      onInsertSql?.(sql);
      onStatus?.(t("dbObjects.insertedToEditor"));
    } catch (e) {
      setError(String(e));
      onStatus?.(t("dbObjects.failed", { error: String(e) }));
    }
  };

  const dropItem = (db: string, kind: ObjectKind, name: string, owner?: string): MenuItem => ({
    label: t("dbObjects.drop"),
    danger: true,
    onClick: () =>
      void applyMutation(
        "drop",
        kind === "trigger"
          ? dropTriggerStatement(sqlEngine, db, name, owner)
          : dropStatement(sqlEngine, kind, target(db, name)),
        t("dbObjects.dropConfirm", { kind: kindLabel(kind), name }),
        db,
        kind,
      ),
  });

  const tableMenu = (db: string, kind: ObjectKind, name: string): MenuItem[] => {
    const items: MenuItem[] = [{ label: t("dbObjects.browse"), onClick: () => onQuickSelect?.(db, name) }];
    if (supportsInlineEdit(sqlEngine)) {
      items.push({ label: t("dbObjects.editData"), onClick: () => onQuickSelect?.(db, name) });
    }
    items.push(
      sep,
      { label: t("dbObjects.insertSelect"), onClick: () => void insertDml(db, name, "select") },
      { label: t("dbObjects.insertInsert"), onClick: () => void insertDml(db, name, "insert") },
      { label: t("dbObjects.insertUpdate"), onClick: () => void insertDml(db, name, "update") },
      { label: t("dbObjects.insertDelete"), onClick: () => void insertDml(db, name, "delete") },
      sep,
      { label: t("dbObjects.viewDdl"), onClick: () => void showDdl(db, kind, name) },
    );
    if (showIndexes) {
      items.push({ label: t("dbObjects.viewIndexes"), onClick: () => void showIndexList(db, name) });
    }
    items.push(
      { label: t("dbObjects.viewStats"), onClick: () => void showStats(db, name) },
      sep,
      { label: t("dbObjects.copyName"), onClick: () => void copy(name) },
      { label: t("dbObjects.rename"), onClick: () => void renameTable(db, kind, name) },
      sep,
      {
        label: t("dbObjects.truncate"),
        danger: true,
        onClick: () =>
          void applyMutation(
            "truncate",
            truncateStatement(sqlEngine, target(db, name)),
            t("dbObjects.truncateConfirm", { name }),
            db,
            kind,
          ),
      },
      dropItem(db, kind, name),
    );
    return items;
  };

  const viewMenu = (db: string, kind: ObjectKind, name: string): MenuItem[] => [
    { label: t("dbObjects.browse"), onClick: () => onQuickSelect?.(db, name) },
    { label: t("dbObjects.viewDefinition"), onClick: () => void showDdl(db, kind, name) },
    { label: t("dbObjects.modify"), onClick: () => void modifyFromDdl(db, kind, name) },
    sep,
    { label: t("dbObjects.copyName"), onClick: () => void copy(name) },
    dropItem(db, kind, name),
  ];

  const procedureMenu = (db: string, name: string): MenuItem[] => [
    { label: t("dbObjects.execProcedure"), onClick: () => onInsertSql?.(callStatement(sqlEngine, target(db, name))) },
    { label: t("dbObjects.viewDdl"), onClick: () => void showDdl(db, "procedure", name) },
    { label: t("dbObjects.copyCall"), onClick: () => onInsertTable?.(callStatement(sqlEngine, target(db, name))) },
    sep,
    dropItem(db, "procedure", name),
  ];

  const functionMenu = (db: string, name: string): MenuItem[] => [
    { label: t("dbObjects.testFunction"), onClick: () => onInsertSql?.(functionCallStatement(sqlEngine, target(db, name))) },
    { label: t("dbObjects.viewDdl"), onClick: () => void showDdl(db, "function", name) },
    {
      label: t("dbObjects.copyInvoke"),
      onClick: () => onInsertTable?.(functionCallStatement(sqlEngine, target(db, name))),
    },
    sep,
    dropItem(db, "function", name),
  ];

  const triggerMenu = (db: string, name: string, owner?: string): MenuItem[] => [
    { label: t("dbObjects.viewDdl"), onClick: () => void showDdl(db, "trigger", name) },
    { label: t("dbObjects.modify"), onClick: () => void modifyFromDdl(db, "trigger", name) },
    {
      label: t("dbObjects.disableTrigger"),
      disabled: actionMode(sqlEngine, "disableTrigger") === "disabled" || !owner,
      onClick: () => {
        if (!owner) return;
        void applyMutation(
          "disableTrigger",
          disableTriggerStatement(sqlEngine, db, name, owner),
          t("dbObjects.disableTriggerConfirm", { name }),
          db,
          "trigger",
          false,
        );
      },
    },
    sep,
    dropItem(db, "trigger", name, owner),
  ];

  const genericObjectMenu = (db: string, kind: ObjectKind, name: string): MenuItem[] => [
    { label: t("dbObjects.viewDdl"), onClick: () => void showDdl(db, kind, name) },
    { label: t("dbObjects.copyName"), onClick: () => void copy(name) },
    sep,
    dropItem(db, kind, name),
  ];

  const objectMenu = (db: string, kind: ObjectKind, name: string, owner?: string): MenuItem[] => {
    switch (kind) {
      case "table":
        return tableMenu(db, kind, name);
      case "view":
      case "materialized_view":
        return viewMenu(db, kind, name);
      case "procedure":
        return procedureMenu(db, name);
      case "function":
        return functionMenu(db, name);
      case "trigger":
        return triggerMenu(db, name, owner);
      default:
        return genericObjectMenu(db, kind, name);
    }
  };

  const multiObjectMenu = (objects: SchemaTreeSelectedObject[]): MenuItem[] => {
    const selectable = objects.filter((object) => SELECTABLE_OBJECT_KINDS.has(object.kind));
    const items: MenuItem[] = [
      {
        label: t("dbObjects.copySelectedNames", { count: objects.length }),
        onClick: () => void copy(objects.map(objectDisplayName).join("\n")),
      },
    ];
    if (selectable.length > 0) {
      items.push({
        label: t("dbObjects.insertSelectedSelects", { count: selectable.length }),
        disabled: !onInsertSql,
        onClick: () => void insertSelectedSelects(selectable),
      });
    }
    items.push(
      sep,
      {
        label: t("dbObjects.viewSelectedDdl", { count: objects.length }),
        onClick: () => void showSelectedDdl(objects),
      },
      {
        label: t("dbObjects.insertSelectedDdl", { count: objects.length }),
        disabled: !onInsertSql,
        onClick: () => void insertSelectedDdl(objects),
      },
    );
    return items;
  };

  const objectContextObjects = (
    db: string,
    kind: ObjectKind,
    name: string,
  ): SchemaTreeSelectedObject[] => {
    const key = objKey(db, kind, name);
    const selected = Object.values(selectedObjects);
    return selectedObjects[key] && selected.length > 1 ? selected : [{ schema: db, name, kind }];
  };

  const openObjectContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    db: string,
    kind: ObjectKind,
    name: string,
    owner?: string,
  ) => {
    const objects = objectContextObjects(db, kind, name);
    if (objects.length > 1) {
      openMenu(event, multiObjectMenu(objects));
      return;
    }
    const key = objKey(db, kind, name);
    if (!selectedObjects[key]) {
      const next = { [key]: { schema: db, name, kind } };
      setSelectedObjects(next);
      publishSelection(next);
    }
    openMenu(event, objectMenu(db, kind, name, owner));
  };

  const columnMenu = (db: string, table: string, col: DbColumnDescription): MenuItem[] => [
    { label: t("dbObjects.copyColumn"), onClick: () => void copy(col.name) },
    { label: t("dbObjects.insertColumn"), onClick: () => onInsertTable?.(columnReference(sqlEngine, col.name)) },
    { label: t("dbObjects.insertCondition"), onClick: () => onInsertTable?.(columnCondition(sqlEngine, col.name)) },
    sep,
    { label: t("dbObjects.modifyColumn"), onClick: () => void modifyColumn(db, table, col) },
    {
      label: t("dbObjects.dropColumn"),
      danger: true,
      onClick: () =>
        void applyMutation(
          "dropColumn",
          dropColumnStatement(sqlEngine, target(db, table), col.name),
          t("dbObjects.dropColumnConfirm", { column: col.name, table }),
          db,
          "table",
        ),
    },
  ];

  const indexMenu = (db: string, table: string, idx: DbIndex): MenuItem[] => [
    { label: t("dbObjects.copyIndexName"), onClick: () => void copy(idx.name) },
    {
      label: t("dbObjects.viewIndexInfo"),
      onClick: () =>
        setDetail({ kind: "result", title: t("dbObjects.indexTitle", { name: idx.name }), result: indexResult([idx]) }),
    },
    sep,
    {
      label: t("dbObjects.dropIndex"),
      danger: true,
      onClick: () =>
        void applyMutation(
          "dropIndex",
          dropIndexStatement(sqlEngine, db, table, idx.name),
          t("dbObjects.dropIndexConfirm", { name: idx.name }),
          db,
          "table",
        ),
    },
  ];

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
      const st = objState[key];
      const isSel = selectedObjects[key] !== undefined;
      return (
        <div key={obj.name}>
          <button
            type="button"
            className="taomni-tree-row w-full text-left"
            style={{ paddingLeft: 34, background: isSel ? "var(--taomni-selected)" : undefined }}
            aria-pressed={isSel}
            onClick={(event) => {
              selectObject(event, db, kind, obj.name);
              if (expandable && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                void toggleObject(db, kind, obj.name);
              }
            }}
            onDoubleClick={() => onInsertTable?.(obj.name)}
            onContextMenu={(event) => openObjectContextMenu(event, db, kind, obj.name, obj.owner)}
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
          onContextMenu={(e) => openMenu(e, columnMenu(db, table, col))}
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
          onContextMenu={(e) => openMenu(e, indexMenu(db, table, idx))}
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
      const isExpanded = expandedDb[dbKey(db)] || filterActive;
      return (
      <div key={db}>
        <div
          className="taomni-tree-row w-full text-left"
          style={{ background: isActive ? "var(--taomni-selected)" : undefined }}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(e, databaseMenu(db));
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
              toggleDb(db);
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
            onClick={() => selectDatabase(db)}
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
                  onClick={() => toggleCategory(db, kind)}
                  onContextMenu={(e) => openMenu(e, categoryMenu(db, kind))}
                >
                  {expandedCat[ckey] || filterActive ? (
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
                {(expandedCat[ckey] || filterActive) && renderObjects(db, kind)}
              </div>
            );
          })}
      </div>
      );
    })
  );

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
          onClick={refreshAll}
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
            className="taomni-input h-5 w-full text-[11px]"
            style={{ paddingLeft: 22, paddingRight: filterActive ? 22 : undefined }}
            value={filterText}
            placeholder={t("dbObjects.filterPlaceholder")}
            aria-label={t("dbObjects.filterLabel")}
            data-testid="schema-tree-filter"
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilterText("");
            }}
          />
          {filterActive && (
            <button
              type="button"
              className="h-5 w-5 absolute right-0.5 top-1/2 -translate-y-1/2 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
              title={t("dbObjects.clearFilter")}
              aria-label={t("dbObjects.clearFilter")}
              onClick={() => setFilterText("")}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
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
              <span className="text-[10px] text-[var(--taomni-text-muted)]">{schemas.length}</span>
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
    </div>
  );
}
