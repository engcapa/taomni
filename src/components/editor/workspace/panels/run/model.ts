import type { ExecutionBuildTarget } from "../../../../../lib/editor/workspace";
import { type ExecutionRunConfiguration, type WorkspaceTask, type WorkspaceToolConfig } from "../../../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../../../types";

export interface WorkspaceTaskItem extends WorkspaceTask {
  rootId: string;
  rootName: string;
  custom?: boolean;
  configuration?: boolean;
  runConfiguration?: ExecutionRunConfiguration;
  /** Provider/shared values before workspace-local overrides. */
  runConfigurationDefaults?: ExecutionRunConfiguration;
  dependsOn?: string[];
  /** Explicit target catalog for toolbar-launched configurations. */
  buildTargets?: ExecutionBuildTarget[];
  /** Structured target identity retained by the Build panel. */
  projectId?: string;
  buildKind?: ExecutionBuildTarget["kind"];
  /** Full configuration catalog used when a toolbar launch starts a compound
   * before the Run panel has performed its own discovery. */
  configurationCatalog?: ExecutionRunConfiguration[];
}

export interface RunHistoryEntry {
  id: string;
  task: WorkspaceTaskItem;
  startedAt: number;
  status: "running" | "passed" | "failed";
  exitCode: number | null;
  message?: string;
}

export interface RunPanelHandle {
  rerunLast: () => boolean;
  run: (task: WorkspaceTaskItem, onExit?: (exitCode: number) => void) => void;
  refresh: () => void;
}

export interface RunPanelProps {
  workspaceInstanceId: string;
  roots: CodeWorkspaceRootInfo[];
  active: boolean;
  onRun: (task: WorkspaceTaskItem, onExit: (exitCode: number) => void) => void;
  /** Per-workspace build/runtime/adapter executable overrides. */
  toolConfig?: WorkspaceToolConfig;
  /** Open the Build/Run tools settings dialog. */
  onConfigureTools?: () => void;
}
