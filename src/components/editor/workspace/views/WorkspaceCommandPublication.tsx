import { useEffect, useLayoutEffect, useMemo } from "react";
import { useWorkspaceActionProjection } from "../hooks/useWorkspaceActionProjection";
import type { ShellShortcutClaim } from "../shellShortcutRouter";
import type { WorkspaceActionProjection } from "../workspaceActionProjection";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";

export interface WorkspaceCommandPublicationProps {
  tabId: string;
  projection: WorkspaceActionProjection;
  shellShortcutClaims: readonly ShellShortcutClaim[];
  onCommandsChange?: (tabId: string, registration: WorkspaceCommandRegistration | null) => void;
}

/** Shell menus observe commands without scheduling another editor render. */
export function WorkspaceCommandPublication({ tabId, projection, shellShortcutClaims, onCommandsChange }: WorkspaceCommandPublicationProps) {
  const { commandRegistration } = useWorkspaceActionProjection(projection);
  const registration = useMemo(() => shellShortcutClaims.length > 0
    ? { ...commandRegistration, shellShortcutClaims } : commandRegistration,
  [commandRegistration, shellShortcutClaims]);
  useLayoutEffect(() => { onCommandsChange?.(tabId, registration); }, [onCommandsChange, tabId, registration]);
  useEffect(() => () => onCommandsChange?.(tabId, null), [onCommandsChange, tabId]);
  return null;
}
