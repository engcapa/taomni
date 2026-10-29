import { useCallback, useRef } from "react";
import type { WorkspaceCommandRegistration } from "../../components/editor/workspace/workspaceCommands";

/** Command ownership is synchronous; only menu consumers need notifications. */
export function useWorkspaceCommandRegistry() {
  const workspaceCommandRegistrationsRef = useRef<Record<string, WorkspaceCommandRegistration>>({});
  const listeners = useRef(new Set<() => void>());
  const handleWorkspaceCommandsChange = useCallback((tabId: string, registration: WorkspaceCommandRegistration | null) => {
    const current = workspaceCommandRegistrationsRef.current;
    if (registration ? current[tabId] === registration : !(tabId in current)) return;
    const next = { ...current };
    if (registration) next[tabId] = registration;
    else delete next[tabId];
    workspaceCommandRegistrationsRef.current = next;
    for (const listener of listeners.current) listener();
  }, []);
  const subscribeWorkspaceCommands = useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);
  return { workspaceCommandRegistrationsRef, handleWorkspaceCommandsChange, subscribeWorkspaceCommands };
}
