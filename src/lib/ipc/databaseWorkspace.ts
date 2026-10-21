import { invoke } from "@tauri-apps/api/core";

// --- Database Query Workspace ---

export interface DbQueryWorkspaceTab {
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

export interface DbQueryWorkspace {
  workspaceId: string;
  activePanelId?: string | null;
  tabs: DbQueryWorkspaceTab[];
  updatedAt: number;
}

export interface DbSaveQueryWorkspaceRequest {
  workspaceId: string;
  activePanelId?: string | null;
  tabs: DbQueryWorkspaceTab[];
  updatedAt: number;
}

export async function dbLoadQueryWorkspace(workspaceId: string): Promise<DbQueryWorkspace | null> {
  return invoke<DbQueryWorkspace | null>("db_load_query_workspace", { workspaceId });
}

export async function dbSaveQueryWorkspace(request: DbSaveQueryWorkspaceRequest): Promise<void> {
  return invoke<void>("db_save_query_workspace", { request });
}

export async function dbCloseQueryWorkspaceTabs(
  workspaceId: string,
  panelIds: string[],
  closedAt: number,
): Promise<void> {
  return invoke<void>("db_close_query_workspace_tabs", { workspaceId, panelIds, closedAt });
}

export async function dbListClosedQueryWorkspaceTabs(
  workspaceId: string,
  limit = 50,
): Promise<DbQueryWorkspaceTab[]> {
  return invoke<DbQueryWorkspaceTab[]>("db_list_closed_query_workspace_tabs", { workspaceId, limit });
}

export async function dbReopenQueryWorkspaceTab(
  workspaceId: string,
  panelId: string,
  tabOrder: number,
  updatedAt: number,
): Promise<boolean> {
  return invoke<boolean>("db_reopen_query_workspace_tab", {
    workspaceId,
    panelId,
    tabOrder,
    updatedAt,
  });
}
