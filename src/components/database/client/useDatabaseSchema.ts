import { useCallback, useEffect, useMemo } from "react";
import { dbExecute } from "../../../lib/ipc";
import { sqlNamespaceFromMetadata } from "../../../lib/sqlMetadataCompletions";
import { type PanelState, type ResultSubTab } from "./types";
import { newResultSheet, engineUsesDatabaseAsSchema, schemaSwitchSql } from "./queryModel";


export interface UseDatabaseSchemaContext {
  setSchemaMap: import("react").Dispatch<import("react").SetStateAction<Record<string, string[]>>>;
  setSchemas: import("react").Dispatch<import("react").SetStateAction<string[]>>;
  setActiveSchema: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  info: import("../../../types").DbConnectInfo;
  metadataCache: import("../../../lib/dbMetadataCache").DbMetadataCache | null;
  setStatusMessage: (message: string) => void;
  activeSchema: string | null;
  metadataVersion: number;
  schemaMap: Record<string, string[]>;
  activePanelId: string;
  connectionSessionId: string | null;
  panels: PanelState[];
  rowLimit: number;
  setPanels: import("react").Dispatch<import("react").SetStateAction<PanelState[]>>;
  tabLimit: number;
}

export function useDatabaseSchema(context: UseDatabaseSchemaContext) {
  const {
    setSchemaMap,
    setSchemas,
    setActiveSchema,
    info,
    metadataCache,
    setStatusMessage,
    activeSchema,
    metadataVersion,
    schemaMap,
    activePanelId,
    connectionSessionId,
    panels,
    rowLimit,
    setPanels,
    tabLimit,
  } = context;

  const onSchemaLoaded = useCallback((tables: Map<string, string[]>) => {
    setSchemaMap((prev) => {
      const next = { ...prev };
      for (const [name, cols] of tables) {
        if (!next[name] || cols.length > 0) next[name] = cols;
      }
      return next;
    });
  }, []);

  const onSchemasLoaded = useCallback((names: string[]) => {
    setSchemas(names);
    setActiveSchema((current) => {
      if (current && names.includes(current)) return current;
      if (engineUsesDatabaseAsSchema(info.engine) && info.database && names.includes(info.database)) return info.database;
      return names[0] ?? null;
    });
  }, [info.database, info.engine]);

  useEffect(() => {
    if (!metadataCache) return;
    let cancelled = false;
    void metadataCache
      .listSchemas(info.catalog)
      .then((names) => {
        if (!cancelled) onSchemasLoaded(names);
      })
      .catch((error) => {
        if (!cancelled) setStatusMessage(`Schema metadata failed: ${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [info.catalog, metadataCache, onSchemasLoaded, setStatusMessage]);

  const metadataSchema = useMemo(
    () =>
      metadataCache
        ? sqlNamespaceFromMetadata({
          cache: metadataCache,
          engine: info.engine,
          activeSchema,
          catalog: info.catalog,
        })
        : undefined,
    [activeSchema, info.catalog, info.engine, metadataCache, metadataVersion],
  );

  const editorSchema = metadataSchema ?? (Object.keys(schemaMap).length > 0 ? schemaMap : undefined);

  const switchSchema = useCallback(
    async (schema: string) => {
      if (!schema || schema === activeSchema) return;
      if (info.engine === "SQLServer") {
        setActiveSchema(schema);
        setStatusMessage(`Active schema: ${schema}`);
        return;
      }
      const panelId = activePanelId;
      const sql = schemaSwitchSql(info.engine, schema, info.catalog);
      try {
        if (!connectionSessionId) throw new Error("Database connection is still starting.");
        await dbExecute(connectionSessionId, sql);
        // Update UI active schema (toolbar dropdown + tree highlight) without
        // dumping a success result sheet on every click.
        setActiveSchema(schema);
        setStatusMessage(`Active schema: ${schema}`);
      } catch (err) {
        const panel = panels.find((p) => p.id === panelId);
        const sheet = newResultSheet(sql, (panel?.sheets.length ?? 0) + 1, rowLimit);
        sheet.title = "Schema";
        setPanels((prev) =>
          prev.map((p) =>
            p.id === panelId
              ? {
                ...p,
                sheets: [
                  ...p.sheets,
                  {
                    ...sheet,
                    result: null,
                    running: false,
                    error: String(err),
                    warnings: [],
                    resultTab: "messages" as ResultSubTab,
                  },
                ].slice(-tabLimit),
                activeSheetId: sheet.id,
              }
              : p,
          ),
        );
        setStatusMessage(`Schema switch failed: ${String(err)}`);
      }
    },
    [activePanelId, activeSchema, connectionSessionId, info.catalog, info.engine, panels, rowLimit, tabLimit],
  );
  return { switchSchema, onSchemasLoaded, onSchemaLoaded, editorSchema };
}
