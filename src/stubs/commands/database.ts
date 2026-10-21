import { type InvokeArgs } from "./runtime";

export const DB_HISTORY_STORAGE_KEY = "taomni.stub.dbSqlHistory.v1";

export const DB_QUERY_WORKSPACES_STORAGE_KEY = "taomni.stub.dbQueryWorkspaces.v1";

export const DB_SAVED_QUERIES_STORAGE_KEY = "taomni.stub.dbSavedQueries.v1";

export interface StubDbSqlHistoryEntry {
  id: string;
  savedSessionId?: string | null;
  engine: string;
  host: string;
  port: number;
  catalog?: string | null;
  databaseName?: string | null;
  schemaName?: string | null;
  sqlContent: string;
  startedAt: number;
  durationMs?: number | null;
  rowsAffected?: number | null;
  rowCount?: number | null;
  hasResultSet: boolean;
  error?: string | null;
  createdAt: number;
  panelId?: string | null;
  tabName?: string | null;
}

export interface StubDbQueryWorkspaceTab {
  workspaceId: string;
  panelId: string;
  tabOrder: number;
  content: string;
  filePath?: string | null;
  fileName?: string | null;
  savedQueryId?: string | null;
  displayName?: string | null;
  dirty: boolean;
  isOpen: boolean;
  closedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface StubDbQueryWorkspace {
  workspaceId: string;
  activePanelId?: string | null;
  tabs: StubDbQueryWorkspaceTab[];
  updatedAt: number;
}

export interface StubDbSavedQuery {
  id: string;
  scopeType: "connection" | "engine";
  scopeId: string;
  engine: string;
  catalogName?: string | null;
  databaseName?: string | null;
  schemaName?: string | null;
  namespaceKey: string;
  name: string;
  content: string;
  remarks?: string | null;
  tags: string[];
  revision: number;
  archivedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export function loadDbSavedQueries(): StubDbSavedQuery[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DB_SAVED_QUERIES_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDbSavedQueries(queries: StubDbSavedQuery[]): void {
  localStorage.setItem(DB_SAVED_QUERIES_STORAGE_KEY, JSON.stringify(queries));
}

export function stubSavedQueryNamespaceKey(
  catalogName?: string | null,
  databaseName?: string | null,
  schemaName?: string | null,
): string {
  const values = [catalogName, databaseName, schemaName].map((value) => value?.trim() ?? "");
  return values.every((value) => !value) ? "" : JSON.stringify(values);
}

export function loadDbQueryWorkspaces(): Record<string, StubDbQueryWorkspace> {
  try {
    const parsed = JSON.parse(localStorage.getItem(DB_QUERY_WORKSPACES_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveDbQueryWorkspaces(workspaces: Record<string, StubDbQueryWorkspace>): void {
  localStorage.setItem(DB_QUERY_WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces));
}

export function loadDbSqlHistory(): StubDbSqlHistoryEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DB_HISTORY_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDbSqlHistory(entries: StubDbSqlHistoryEntry[]): void {
  localStorage.setItem(DB_HISTORY_STORAGE_KEY, JSON.stringify(entries));
}

export async function invokeDatabase<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    case "db_append_history": {
      const invokeArgs = args as InvokeArgs | undefined;
      const entry = invokeArgs?.entry as StubDbSqlHistoryEntry | undefined;
      if (!entry?.id) return undefined as T;
      const entries = loadDbSqlHistory().filter((candidate) => candidate.id !== entry.id);
      saveDbSqlHistory([entry, ...entries].slice(0, 1000));
      return undefined as T;
    }

    case "db_list_history": {
      const invokeArgs = args as InvokeArgs | undefined;
      const savedSessionId = (invokeArgs?.savedSessionId as string | null | undefined) ?? null;
      const engine = (invokeArgs?.engine as string | null | undefined) ?? null;
      const limit = Math.max(1, Math.min(1000, Number((invokeArgs?.limit as number | undefined) ?? 200)));
      const entries = loadDbSqlHistory()
        .filter((entry) => !savedSessionId || entry.savedSessionId === savedSessionId)
        .filter((entry) => !engine || entry.engine === engine)
        .sort((a, b) => (b.startedAt - a.startedAt) || (b.createdAt - a.createdAt))
        .slice(0, limit);
      return entries as T;
    }

    case "db_delete_history": {
      const invokeArgs = args as InvokeArgs | undefined;
      const id = (invokeArgs?.id as string | undefined) ?? "";
      saveDbSqlHistory(loadDbSqlHistory().filter((entry) => entry.id !== id));
      return undefined as T;
    }

    case "db_clear_history": {
      const invokeArgs = args as InvokeArgs | undefined;
      const savedSessionId = (invokeArgs?.savedSessionId as string | null | undefined) ?? null;
      saveDbSqlHistory(
        savedSessionId
          ? loadDbSqlHistory().filter((entry) => entry.savedSessionId !== savedSessionId)
          : [],
      );
      return undefined as T;
    }

    case "db_update_history_tab_name": {
      const invokeArgs = args as InvokeArgs | undefined;
      const savedSessionId = (invokeArgs?.savedSessionId as string | undefined) ?? "";
      const panelId = (invokeArgs?.panelId as string | undefined) ?? "";
      const tabName = (invokeArgs?.tabName as string | null | undefined) ?? null;
      let changed = 0;
      saveDbSqlHistory(
        loadDbSqlHistory().map((entry) => {
          if (entry.savedSessionId !== savedSessionId || entry.panelId !== panelId) return entry;
          changed += 1;
          return { ...entry, tabName };
        }),
      );
      return changed as T;
    }

    case "db_load_query_workspace": {
      const workspaceId = String((args as InvokeArgs | undefined)?.workspaceId ?? "");
      const workspace = loadDbQueryWorkspaces()[workspaceId];
      if (!workspace) return null as T;
      return {
        ...workspace,
        tabs: workspace.tabs
          .filter((tab) => tab.isOpen)
          .sort((left, right) => left.tabOrder - right.tabOrder),
      } as T;
    }

    case "db_save_query_workspace": {
      const request = (args as InvokeArgs | undefined)?.request as StubDbQueryWorkspace | undefined;
      if (!request?.workspaceId) return undefined as T;
      const workspaces = loadDbQueryWorkspaces();
      const previous = workspaces[request.workspaceId];
      const previousTabs = new Map((previous?.tabs ?? []).map((tab) => [tab.panelId, tab]));
      for (const tab of request.tabs) {
        const existing = previousTabs.get(tab.panelId);
        previousTabs.set(tab.panelId, {
          ...tab,
          createdAt: existing?.createdAt ?? tab.createdAt,
          isOpen: true,
          closedAt: null,
        });
      }
      workspaces[request.workspaceId] = {
        ...request,
        tabs: [...previousTabs.values()],
      };
      saveDbQueryWorkspaces(workspaces);
      return undefined as T;
    }

    case "db_close_query_workspace_tabs": {
      const invokeArgs = args as InvokeArgs | undefined;
      const workspaceId = String(invokeArgs?.workspaceId ?? "");
      const panelIds = new Set(Array.isArray(invokeArgs?.panelIds) ? invokeArgs.panelIds.map(String) : []);
      const closedAt = Number(invokeArgs?.closedAt ?? Date.now());
      const workspaces = loadDbQueryWorkspaces();
      const workspace = workspaces[workspaceId];
      if (workspace) {
        workspace.tabs = workspace.tabs.map((tab) => panelIds.has(tab.panelId)
          ? { ...tab, isOpen: false, closedAt, updatedAt: closedAt }
          : tab);
        if (workspace.activePanelId && panelIds.has(workspace.activePanelId)) {
          workspace.activePanelId = null;
        }
        workspace.updatedAt = closedAt;
        saveDbQueryWorkspaces(workspaces);
      }
      return undefined as T;
    }

    case "db_list_closed_query_workspace_tabs": {
      const invokeArgs = args as InvokeArgs | undefined;
      const workspaceId = String(invokeArgs?.workspaceId ?? "");
      const limit = Math.max(1, Math.min(200, Number(invokeArgs?.limit ?? 50)));
      return (loadDbQueryWorkspaces()[workspaceId]?.tabs ?? [])
        .filter((tab) => !tab.isOpen)
        .sort((left, right) => (right.closedAt ?? 0) - (left.closedAt ?? 0))
        .slice(0, limit) as T;
    }

    case "db_reopen_query_workspace_tab": {
      const invokeArgs = args as InvokeArgs | undefined;
      const workspaceId = String(invokeArgs?.workspaceId ?? "");
      const panelId = String(invokeArgs?.panelId ?? "");
      const workspaces = loadDbQueryWorkspaces();
      const workspace = workspaces[workspaceId];
      const tab = workspace?.tabs.find((candidate) => candidate.panelId === panelId);
      if (!workspace || !tab) return false as T;
      tab.isOpen = true;
      tab.closedAt = null;
      tab.tabOrder = Number(invokeArgs?.tabOrder ?? workspace.tabs.length);
      tab.updatedAt = Number(invokeArgs?.updatedAt ?? Date.now());
      saveDbQueryWorkspaces(workspaces);
      return true as T;
    }

    case "db_list_saved_queries": {
      const request = ((args as InvokeArgs | undefined)?.request ?? {}) as Record<string, unknown>;
      const connectionId = typeof request.connectionId === "string" ? request.connectionId : null;
      const engine = typeof request.engine === "string" ? request.engine : null;
      const namespaceKey = stubSavedQueryNamespaceKey(
        typeof request.catalogName === "string" ? request.catalogName : null,
        typeof request.databaseName === "string" ? request.databaseName : null,
        typeof request.schemaName === "string" ? request.schemaName : null,
      );
      return loadDbSavedQueries()
        .filter((query) => Boolean(request.includeArchived) || query.archivedAt == null)
        .filter((query) => (
          (connectionId && query.scopeType === "connection" && query.scopeId === connectionId)
          || (engine && query.scopeType === "engine" && query.scopeId === engine)
          || (!connectionId && !engine)
        ))
        .filter((query) => Boolean(request.includeAllNamespaces)
          || !query.namespaceKey
          || query.namespaceKey === namespaceKey)
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })) as T;
    }

    case "db_get_saved_query": {
      const id = String((args as InvokeArgs | undefined)?.id ?? "");
      return (loadDbSavedQueries().find((query) => query.id === id) ?? null) as T;
    }

    case "db_save_saved_query": {
      const query = (args as InvokeArgs | undefined)?.query as StubDbSavedQuery | undefined;
      if (!query?.id) throw new Error("saved query id is required");
      const queries = loadDbSavedQueries();
      const existingIndex = queries.findIndex((candidate) => candidate.id === query.id);
      const namespaceKey = stubSavedQueryNamespaceKey(
        query.catalogName,
        query.databaseName,
        query.schemaName,
      );
      const nameConflict = queries.some((candidate) => candidate.id !== query.id
        && candidate.scopeType === query.scopeType
        && candidate.scopeId === query.scopeId
        && candidate.namespaceKey === namespaceKey
        && candidate.name.localeCompare(query.name, undefined, { sensitivity: "base" }) === 0);
      if (nameConflict) throw new Error(`saved_query_name_conflict:${query.name}`);
      let name = query.name.trim();
      if (!name) {
        let ordinal = 1;
        do {
          name = `Query-${ordinal}`;
          ordinal += 1;
        } while (queries.some((candidate) => candidate.scopeType === query.scopeType
          && candidate.scopeId === query.scopeId
          && candidate.namespaceKey === namespaceKey
          && candidate.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0));
      }
      const existing = existingIndex >= 0 ? queries[existingIndex] : null;
      if (existing && existing.revision !== query.revision) {
        throw new Error(`saved_query_revision_conflict:${query.id}:${query.revision}:${existing.revision}`);
      }
      const saved: StubDbSavedQuery = {
        ...query,
        name,
        namespaceKey,
        revision: existing ? existing.revision + 1 : 1,
        createdAt: existing?.createdAt ?? query.createdAt,
      };
      if (existingIndex >= 0) queries[existingIndex] = saved;
      else queries.push(saved);
      saveDbSavedQueries(queries);
      return saved as T;
    }

    case "db_archive_saved_query": {
      const invokeArgs = args as InvokeArgs | undefined;
      const id = String(invokeArgs?.id ?? "");
      const revision = Number(invokeArgs?.revision ?? 0);
      const queries = loadDbSavedQueries();
      const query = queries.find((candidate) => candidate.id === id);
      if (!query || query.revision !== revision) {
        throw new Error(`saved_query_revision_conflict:${id}:${revision}`);
      }
      query.archivedAt = typeof invokeArgs?.archivedAt === "number" ? invokeArgs.archivedAt : null;
      query.updatedAt = Number(invokeArgs?.updatedAt ?? Date.now());
      query.revision += 1;
      saveDbSavedQueries(queries);
      return query.revision as T;
    }

    case "db_delete_saved_query": {
      const id = String((args as InvokeArgs | undefined)?.id ?? "");
      const queries = loadDbSavedQueries();
      const next = queries.filter((query) => query.id !== id);
      saveDbSavedQueries(next);
      return (next.length !== queries.length) as T;
    }

    // ---------- Database client commands (desktop-only) ----------
    case "db_connect":

    case "db_ping":

    case "db_disconnect":

    case "db_list_catalogs":

    case "db_list_schemas":

    case "db_list_tables":

    case "db_describe_table":

    case "db_list_foreign_keys":

    case "db_list_indexes":

    case "db_execute":

    case "db_execute_stream":

    case "db_cancel":

    case "redis_list_keys":

    case "redis_get_key":

    case "redis_set_key":

    case "redis_del_key":

    case "redis_exec":

    case "hbase_connect":

    case "hbase_ping":

    case "hbase_disconnect":

    case "hbase_list_tables":

    case "hbase_describe_table":

    case "hbase_execute": {
      throw new Error(
        "Database and HBase connections are not available in browser preview. Use the desktop build of Taomni.",
      );
    }
    default: throw new Error(`Unhandled database stub command: ${cmd}`);
  }
}
