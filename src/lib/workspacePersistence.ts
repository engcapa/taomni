import { invoke } from "@tauri-apps/api/core";
import type { Workspace } from "../types/workspace";

export const listWorkspaces = () => invoke<Workspace[]>("list_workspaces");
export const saveWorkspace = (workspace: Workspace) => invoke<Workspace>("save_workspace", { workspace });
export const deleteWorkspace = (workspace: Workspace) => invoke<void>("delete_workspace", { id: workspace.id, revision: workspace.revision });
