import { type MouseEvent as ReactMouseEvent } from "react";
import { writeText } from "../../../lib/clipboard";
import { useT } from "../../../lib/i18n";
import { dbExecute, dbListIndexes, dbObjectDdl, dbTableStats, type DbColumnDescription, type DbIndex, type DbQueryResult } from "../../../lib/ipc";
import {
  actionMode,
  alterColumnStatement,
  callStatement,
  columnCondition,
  columnReference,
  createTemplate,
  deleteStatement,
  disableTriggerStatement,
  dropColumnStatement,
  dropDatabaseStatement,
  dropIndexStatement,
  dropStatement,
  dropTriggerStatement,
  functionCallStatement,
  insertStatement,
  renameDatabaseStatement,
  renameTableStatement,
  selectStatement,
  supportsInlineEdit,
  truncateStatement,
  updateStatement,
  type DialectAction,
  type ObjectKind,
  type ObjectTarget,
} from "../../../lib/sqlDialect";
import { type MenuItem } from "../../ContextMenu";
import { useConfirmDialog, useTextInputDialog } from "../../sidebar/ConfirmDialog";
import { type ObjectDetail } from "../DbObjectDetailDialog";
import { objKey, SELECTABLE_OBJECT_KINDS } from "./presentation";
import { type SchemaTreeSelectedObject } from "./types";
import { useSchemaMetadata } from "./useSchemaMetadata";

export interface UseSchemaActionsContext {
  catalog: string | null | undefined;
  onStatus: ((message: string) => void) | undefined;
  t: ReturnType<typeof useT>;
  sessionId: string;
  metadata: ReturnType<typeof useSchemaMetadata>;
  sqlEngine: import("../../../lib/sqlDialect").SqlEngine;
  onInsertSql: ((sql: string) => void) | undefined;
  confirmDialog: ReturnType<typeof useConfirmDialog>;
  quickSelectLimit: number;
  setDetail: import("react").Dispatch<import("react").SetStateAction<ObjectDetail | null>>;
  setTableDetail: import("react").Dispatch<import("react").SetStateAction<{ schema: string; table: string; kind: "table" | "view" | "materialized_view"; } | null>>;
  inputDialog: ReturnType<typeof useTextInputDialog>;
  onNewQuery: (() => void) | undefined;
  categories: ObjectKind[];
  onSetDefaultSchema: ((schema: string) => void) | undefined;
  onQuickSelect: ((schema: string | null, table: string) => void) | undefined;
  showIndexes: boolean;
  onInsertTable: ((table: string) => void) | undefined;
  selectedObjects: Record<string, SchemaTreeSelectedObject>;
  openMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
  setSelectedObjects: import("react").Dispatch<import("react").SetStateAction<Record<string, SchemaTreeSelectedObject>>>;
  publishSelection: (next: Record<string, SchemaTreeSelectedObject>) => void;
}

export function useSchemaActions(context: UseSchemaActionsContext) {
  const {
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
  } = context;

  const target = (db: string | null, name: string): ObjectTarget => ({ catalog, schema: db, name });

  const copy = async (text: string) => {
    await writeText(text);
    onStatus?.(t("dbObjects.copied"));
  };

  const runExec = async (sql: string, db: string, kind: ObjectKind) => {
    try {
      await dbExecute(sessionId, sql);
      onStatus?.(t("dbObjects.executed", { sql }));
      metadata.cache.invalidate({ catalog, schema: db });
      metadata.setObjState((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${db}::`)) delete next[key];
        }
        return next;
      });
      await metadata.refreshAfter(db, kind);
    } catch (e) {
      metadata.setError(String(e));
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
      metadata.objState[objKey(keyDb, "table", name)]?.columns ??
      metadata.objState[objKey(keyDb, "view", name)]?.columns ??
      metadata.objState[objKey(keyDb, "materialized_view", name)]?.columns;
    if (cached) return cached;
    return metadata.cache.describeTable(db, name, catalog).catch(() => [] as DbColumnDescription[]);
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
      metadata.setError(String(e));
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
        const cols = await metadata.cache.describeTable(object.schema, object.name, catalog).catch(() => [] as DbColumnDescription[]);
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
      metadata.setError(String(e));
      onStatus?.(t("dbObjects.failed", { error: String(e) }));
    }
  };

  const showTableDetail = (db: string, kind: "table" | "view" | "materialized_view", name: string) => {
    setTableDetail({ schema: db, table: name, kind });
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
      metadata.setError(String(e));
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
    { label: t("dbObjects.refresh"), onClick: () => void metadata.refreshAfter(db, kind) },
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
      metadata.setError(String(e));
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

  const tableMenu = (db: string, kind: "table" | "view" | "materialized_view", name: string): MenuItem[] => {
    const items: MenuItem[] = [
      { label: t("dbObjects.openDetail"), onClick: () => showTableDetail(db, kind, name) },
      { label: t("dbObjects.browse"), onClick: () => onQuickSelect?.(db, name) },
    ];
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
  return {
    target,
    openObjectContextMenu,
    columnMenu,
    indexMenu,
    databaseMenu,
    categoryMenu,
  };
}
