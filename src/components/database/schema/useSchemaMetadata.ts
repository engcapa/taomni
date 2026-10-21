import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createDbMetadataCache } from "../../../lib/dbMetadataCache";
import { dbListIndexes, dbListObjects, type DbIndex, type DbObject, type DbTable } from "../../../lib/ipc";
import { type ObjectKind } from "../../../lib/sqlDialect";
import { catKey, objKey, TABLE_CATEGORIES } from "./presentation";
import { type ObjNodeState } from "./types";

export interface UseSchemaMetadataContext {
  sessionId: string;
  catalog: string | null | undefined;
  metadataCache: import("../../../lib/dbMetadataCache").DbMetadataCache | undefined;
  onSchemasLoaded: ((schemas: string[]) => void) | undefined;
  onSchemaLoaded: ((tables: Map<string, string[]>) => void) | undefined;
  onSetDefaultSchema: ((schema: string) => void) | undefined;
  showIndexes: boolean;
}

export function useSchemaMetadata(context: UseSchemaMetadataContext) {
  const { sessionId, catalog, metadataCache, onSchemasLoaded, onSchemaLoaded, onSetDefaultSchema, showIndexes } = context;

  const [schemas, setSchemas] = useState<string[]>([]);
  const [expandedDb, setExpandedDb] = useState<Record<string, boolean>>({});
  const [expandedCat, setExpandedCat] = useState<Record<string, boolean>>({});
  const [tablesByDb, setTablesByDb] = useState<Record<string, DbTable[]>>({});
  const [objectsByCat, setObjectsByCat] = useState<Record<string, DbObject[]>>({});
  const [objState, setObjState] = useState<Record<string, ObjNodeState>>({});
  const [error, setError] = useState<string | null>(null);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const loadingTablesRef = useRef(new Set<string>());
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

  const refreshAll = () => {
    cache.clearAll();
    setTablesByDb({});
    setObjectsByCat({});
    setObjState({});
    void loadSchemas();
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
  return {
    schemas,
    ensureTables,
    tablesByDb,
    objectsByCat,
    cache,
    setObjState,
    refreshAfter,
    setError,
    objState,
    toggleObject,
    expandedDb,
    toggleDb,
    selectDatabase,
    toggleCategory,
    expandedCat,
    refreshAll,
    error,
    loadingSchemas,
  };
}
