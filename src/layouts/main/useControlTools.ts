import { useEffect, useCallback } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Tab } from "../../types";
import { type SessionConfig } from "../../lib/ipc";
import { type TerminalProfile } from "../../lib/terminalProfile";
import type { LocalLaunchOutcome, LocalShellSelection } from "../../types";
import { type ControlToolExecutor, type ControlToolDispatch } from "./types";
import { createExecuteControlTool } from "./controlTools";


export interface UseControlToolsContext {
  tabsRef: import("react").RefObject<Tab[]>;
  loadSessions: () => Promise<void>;
  openQueuedSession: (session: SessionConfig, localShellOverride?: LocalShellSelection, resume?: import("./types").ResumeQueueContext) => import("./types").ConnectQueueOutcome;
  setEditingSession: import("react").Dispatch<import("react").SetStateAction<SessionConfig | undefined>>;
  setNewSessionGroupPath: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  setNewSessionInitialProto: import("react").Dispatch<import("react").SetStateAction<string | undefined>>;
  setShowSessionEditor: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  handleQuickConnect: (value: string) => void;
  setActiveTab: (id: string) => void;
  handleDuplicateTab: (tabId: string) => Promise<void>;
  updateTabTitle: (id: string, title: string) => void;
  removeTab: (id: string) => void;
  moveTabToIndex: (id: string, toIndex: number) => void;
  openSettingsTab: () => void;
  openLocalTab: (title?: string, sessionId?: string, terminalProfile?: TerminalProfile, localShell?: LocalShellSelection, initialCwd?: string, chatTabId?: string) => Promise<LocalLaunchOutcome>;
  openFileBrowserTab: (title: string, initialPath: string, sessionId?: string) => void;
  executeControlToolRef: import("react").RefObject<ControlToolExecutor | null>;
  seenControlToolCallsRef: import("react").RefObject<Set<string>>;
}

export function useControlTools(context: UseControlToolsContext) {
  const {
    tabsRef,
    loadSessions,
    openQueuedSession,
    setEditingSession,
    setNewSessionGroupPath,
    setNewSessionInitialProto,
    setShowSessionEditor,
    handleQuickConnect,
    setActiveTab,
    handleDuplicateTab,
    updateTabTitle,
    removeTab,
    moveTabToIndex,
    openSettingsTab,
    openLocalTab,
    openFileBrowserTab,
    executeControlToolRef,
    seenControlToolCallsRef,
  } = context;

  const executeControlTool = useCallback(createExecuteControlTool({
    tabsRef,
    loadSessions,
    openQueuedSession,
    setEditingSession,
    setNewSessionGroupPath,
    setNewSessionInitialProto,
    setShowSessionEditor,
    handleQuickConnect,
    setActiveTab,
    handleDuplicateTab,
    updateTabTitle,
    removeTab,
    moveTabToIndex,
    openSettingsTab,
    openLocalTab,
    openFileBrowserTab,
  }), [
    handleDuplicateTab,
    handleQuickConnect,
    loadSessions,
    moveTabToIndex,
    openFileBrowserTab,
    openLocalTab,
    openQueuedSession,
    openSettingsTab,
    removeTab,
    setActiveTab,
    updateTabTitle,
  ]);

  useEffect(() => {
    executeControlToolRef.current = executeControlTool;
  }, [executeControlTool]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<ControlToolDispatch>("agent-cc-control-tool", (event) => {
      const executor = executeControlToolRef.current;
      if (!executor) return;
      const callId = event.payload.callId;
      const seen = seenControlToolCallsRef.current;
      if (seen.has(callId)) return;
      if (seen.size > 5000) seen.clear();
      seen.add(callId);
      void executor(event.payload);
    }).then((fn) => {
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => { });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return {};
}
