import { useContext } from "react";
import { useWorkspaceHostFiles, type WorkspaceHostFilesDependencies } from "../hooks/useWorkspaceHostFiles";
import { WorkspaceHostRequestContext } from "../workspaceHostIntegration";

/** Receive navigation directly; publish only the reconciled buffer to its UI. */
export function WorkspaceHostFilesBridge(dependencies: Omit<WorkspaceHostFilesDependencies, "host">) {
  const host = useContext(WorkspaceHostRequestContext) ?? undefined;
  useWorkspaceHostFiles({ ...dependencies, host });
  return null;
}
