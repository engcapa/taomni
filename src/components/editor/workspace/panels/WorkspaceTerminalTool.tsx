import { useWorkspaceHost } from "../workspaceHostIntegration";
import { TerminalDockPanel, type TerminalDockHandle } from "./TerminalDockPanel";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import type { RefObject } from "react";

/** One terminal owner, regardless of whether its node is inside or below the editor. */
export function WorkspaceTerminalTool({ terminalRef, workspaceInstanceId, roots, defaultCwd, editorActive }: {
  terminalRef: RefObject<TerminalDockHandle | null>;
  workspaceInstanceId: string;
  roots: CodeWorkspaceRootInfo[];
  defaultCwd: string;
  editorActive: boolean;
}) {
  const host = useWorkspaceHost();
  const active = host?.terminalTool?.external ? host.terminalTool.visible : editorActive && (!host || host.editorVisible);
  return <TerminalDockPanel ref={terminalRef} workspaceInstanceId={workspaceInstanceId}
    roots={roots} defaultCwd={defaultCwd} active={active} />;
}
