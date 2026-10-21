import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type WorkspaceToolConfig } from "../../../../lib/editor/workspace";
import { readWorkspaceBuildRunTools, workspaceToolConfig, type WorkspaceBuildRunTools } from "../codeWorkspaceModel";
import { type WorkspaceTaskItem } from "../panels/RunPanel";
import { type TerminalDockHandle } from "../panels/TerminalDockPanel";
import { useWorkspaceToolWindowRouting } from "./useWorkspaceToolWindowRouting";


export interface UseWorkspaceBuildToolsContext {
  workspaceInstanceId: string;
  terminalDockRef: import("react").RefObject<TerminalDockHandle | null>;
  toolWindowRouting: ReturnType<typeof useWorkspaceToolWindowRouting>;
}

export function useWorkspaceBuildTools(context: UseWorkspaceBuildToolsContext) {
  const { workspaceInstanceId, terminalDockRef, toolWindowRouting } = context;

  // Per-workspace Maven/Gradle executable overrides (project wrapper still wins;
  // this is the "configured" tier between wrapper and PATH). Persisted per
  // workspace instance and threaded into every task/dependency detector.
  const [buildRunTools, setBuildRunTools] = useState<WorkspaceBuildRunTools>(
    () => readWorkspaceBuildRunTools(workspaceInstanceId),
  );
  const [buildRunToolsOpen, setBuildRunToolsOpen] = useState(false);
  useEffect(() => {
    setBuildRunTools(readWorkspaceBuildRunTools(workspaceInstanceId));
  }, [workspaceInstanceId]);
  const toolConfig = useMemo<WorkspaceToolConfig | undefined>(
    () => workspaceToolConfig(buildRunTools),
    [buildRunTools],
  );
  const toolConfigRef = useRef(toolConfig);
  toolConfigRef.current = toolConfig;

  /** Run a workspace task in the integrated terminal (shared by Run + Build panels). */
  const runWorkspaceTask = useCallback(
    (task: WorkspaceTaskItem, onExit?: (exitCode: number) => void) => {
      terminalDockRef.current?.runCommand(
        task.command,
        task.cwd,
        `Run: ${task.label}`,
        onExit,
        task.environment,
        task.execution,
      );
      toolWindowRouting.setBottomDockTab("terminal");
      toolWindowRouting.setBottomDockOpen(true);
    },
    [toolWindowRouting.setBottomDockOpen, toolWindowRouting.setBottomDockTab],
  );
  return {
    toolConfigRef,
    toolConfig,
    runWorkspaceTask,
    buildRunTools,
    setBuildRunToolsOpen,
    buildRunToolsOpen,
    setBuildRunTools,
  };
}
