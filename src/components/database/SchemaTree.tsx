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
  Boxes,
  Braces,
  SquareFunction,
  Zap,
  CalendarClock,
  ListOrdered,
  BookText,
} from "lucide-react";
import {
  dbListSchemas,
  dbListTables,
  dbListObjects,
  dbDescribeTable,
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
  /** Called when a table is selected (single click). */
  onSelectTable?: (schema: string | null, table: string) => void;
  /** Called when a table is double-clicked — inserts its name into the editor. */
  onInsertTable?: (table: string) => void;
  /** "Select top N rows" context action. */
  onQuickSelect?: (schema: string | null, table: string) => void;
  quickSelectLimit?: number;
  /** Presto catalog, needed to fully-qualify object names. */
  catalog?: string | null;
  /** Insert a full statement into a new query panel (for review/run). */
  onInsertSql?: (sql: string) => void;
  /** Open a fresh, empty query panel. */
  onNewQuery?: () => void;
  /** Make a schema the session default. */
  onSetDefaultSchema?: (schema: string) => void;
  /** Surface a transient status message. */
  onStatus?: (message: string) => void;
  /** Bubble up schema names for the editor toolbar selector. */
  onSchemasLoaded?: (schemas: string[]) => void;
  /** Bubble up the loaded schema → tables/columns for editor autocomplete. */
  onSchemaLoaded?: (tables: Map<string, string[]>) => void;
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
  onSelectTable,
  onInsertTable,
  onQuickSelect,
  quickSelectLimit = 1000,
  catalog,
  onInsertSql,
  onNewQuery,
  onSetDefaultSchema,
  onStatus,
  onSchemasLoaded,
  onSchemaLoaded,
}: SchemaTreeProps) {
  const t = useT();
  const sqlEngine = asSqlEngine(engine);
  const categories = categoriesForEngine(sqlEngine);
  const showIndexes = supportsIndexes(sqlEngine);
  const confirmDialog = useConfirmDialog();
  const inputDialog = useTextInputDialog();
  const [detail, setDetail] = useState<ObjectDetail | null>(null);

  const [schemas, setSchemas] = useState<string[]>([]);
  const [expandedDb, setExpandedDb] = useState<Record<string, boolean>>({});
  const [expandedCat, setExpandedCat] = useState<Record<string, boolean>>({});
  const [tablesByDb, setTablesByDb] = useState<Record<string, DbTable[]>>({});
  const [objectsByCat, setObjectsByCat] = useState<Record<string, DbObject[]>>({});
  const [objState, setObjState] = useState<Record<string, ObjNodeState>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const { show: openMenu, render: menu } = useContextMenu();

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

  const ensureTables = useCallback(
    async (db: string) => {
      if (tablesByDb[db]) return;
      try {
        const list = await dbListTables(sessionId, db);
        setTablesByDb((prev) => ({ ...prev, [db]: list }));
        onSchemaLoaded?.(new Map(list.map((t) => [t.name, [] as string[]])));
      } catch (err) {
        setError(String(err));
      }
    },
    [sessionId, tablesByDb, onSchemaLoaded],
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
          dbDescribeTable(sessionId, db, name),
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

  const selectObject = (db: string, kind: ObjectKind, name: string) => {
    setSelected(objKey(db, kind, name));
    onSelectTable?.(db, name);
  };

  const refreshAll = () => {
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

  const categoryCount = (db: string, kind: ObjectKind): number | null => {
    if (TABLE_CATEGORIES.includes(kind)) {
      return tablesByDb[db] ? tablesByDb[db].filter((t) => t.kind === kind).length : null;
    }
    const list = objectsByCat[catKey(db, kind)];
    return list ? list.length : null;
  };

  const target = (db: string, name: string): ObjectTarget => ({ catalog, schema: db, name });

  const copy = async (text: string) => {
    await writeText(text);
    onStatus?.(t("dbObjects.copied"));
  };

  const refreshAfter = useCallback(
    async (db: string, kind: ObjectKind) => {
      if (TABLE_CATEGORIES.includes(kind)) {
        try {
          const list = await dbListTables(sessionId, db);
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
    [sessionId],
  );

  const runExec = async (sql: string, db: string, kind: ObjectKind) => {
    try {
      await dbExecute(sessionId, sql);
      onStatus?.(t("dbObjects.executed", { sql }));
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

  const getColumns = async (db: string, name: string): Promise<DbColumnDescription[]> => {
    const cached = objState[objKey(db, "table", name)]?.columns ?? objState[objKey(db, "view", name)]?.columns;
    if (cached) return cached;
    return dbDescribeTable(sessionId, db, name).catch(() => [] as DbColumnDescription[]);
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
    const items = objectsFor(db, kind);
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
      const isSel = selected === key;
      return (
        <div key={obj.name}>
          <button
            type="button"
            className="taomni-tree-row w-full text-left"
            style={{ paddingLeft: 34, background: isSel ? "var(--taomni-selected)" : undefined }}
            onClick={() => {
              selectObject(db, kind, obj.name);
              if (expandable) void toggleObject(db, kind, obj.name);
            }}
            onDoubleClick={() => onInsertTable?.(obj.name)}
            onContextMenu={(e) => openMenu(e, objectMenu(db, kind, obj.name, obj.owner))}
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
        {schemas.map((db) => (
          <div key={db}>
            <button
              type="button"
              className="taomni-tree-row w-full text-left"
              onClick={() => toggleDb(db)}
              onContextMenu={(e) => openMenu(e, databaseMenu(db))}
            >
              {expandedDb[dbKey(db)] ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <Database className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
              <span className="flex-1 truncate">{db}</span>
            </button>
            {expandedDb[dbKey(db)] &&
              categories.map((kind) => {
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
                      {expandedCat[ckey] ? (
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
                    {expandedCat[ckey] && renderObjects(db, kind)}
                  </div>
                );
              })}
          </div>
        ))}
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




