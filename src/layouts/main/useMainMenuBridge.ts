import { useEffect, useRef } from "react";
import type { AppCommand } from "../../components/menubar/commands";
import { buildAppMenuSpec, installAppMenu, type MenuActionId } from "../../lib/nativeAppMenu";
import type { WorkspaceCommandRegistration } from "../../components/editor/workspace/workspaceCommands";
import { resolveShellShortcutRoute } from "../../components/editor/workspace/shellShortcutRouter";
import { shellKeyClaimed } from "../../lib/shellKeyClaims";
import type { Tab } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { macCommandDigitIndex } from "./sessionPolicy";

export interface UseMainMenuBridgeContext {
  dispatchMenuAction: (action: MenuActionId) => void;
  nativeMenu: boolean;
  activeTab: Tab | undefined;
  importExport: import("../../components/menubar/useSessionImportExport").UseSessionImportExport;
  quickConnectVisible: boolean;
  activeWorkspaceCommandRegistration: WorkspaceCommandRegistration | null;
  t: import("../../lib/i18n").TranslateFn;
  setActiveTab: (id: string) => void;
  workspaceCommandRegistrationsRef: import("react").RefObject<Record<string, WorkspaceCommandRegistration>>;
  handleCommand: (command: AppCommand) => void;
}

export function useMainMenuBridge(context: UseMainMenuBridgeContext) {
  const {
    dispatchMenuAction,
    nativeMenu,
    activeTab,
    importExport,
    quickConnectVisible,
    activeWorkspaceCommandRegistration,
    t,
    setActiveTab,
    workspaceCommandRegistrationsRef,
    handleCommand,
  } = context;

  const dispatchMenuActionRef = useRef(dispatchMenuAction);
  useEffect(() => {
    dispatchMenuActionRef.current = dispatchMenuAction;
  }, [dispatchMenuAction]);

  // Build + install the macOS global menu. Rebuilt whenever a piece of state
  // shown in the menu changes (checkmarks, enabled state) — all low-frequency,
  // so a full rebuild is simpler and cheaper than mutating individual items.
  useEffect(() => {
    if (!nativeMenu) return;
    let cancelled = false;
    const spec = buildAppMenuSpec({
      activeTabClosable: !!activeTab?.closable,
      hasSessions: importExport.hasSessions,
      quickConnectVisible,
      workspaceCommands: activeWorkspaceCommandRegistration?.items ?? [],
      t,
    });
    void installAppMenu(spec, (action) => dispatchMenuActionRef.current(action)).catch((err) => {
      if (!cancelled) console.error("Failed to install application menu", err);
    });
    return () => {
      cancelled = true;
    };
  }, [
    nativeMenu,
    activeTab?.closable,
    importExport.hasSessions,
    quickConnectVisible,
    activeWorkspaceCommandRegistration?.items,
    t,
  ]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const tabIndex = macCommandDigitIndex(event);
      // A focused surface that binds the same chord (Code Workspace Cmd+1
      // Project on macOS) keeps it; its own keymap dispatches the action.
      if (tabIndex !== null && !shellKeyClaimed(event)) {
        event.preventDefault();
        event.stopPropagation();

        const state = useAppStore.getState();
        const target = tabIndex === -1 ? state.tabs.at(-1) : state.tabs[tabIndex];
        if (target && target.id !== state.activeTabId) {
          setActiveTab(target.id);
        }
        return;
      }

      const primary = event.ctrlKey || event.metaKey;
      if (!primary || !event.shiftKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key !== "t" && key !== "n") return;

      if (key === "t") {
        // W0 §8.20.1 root routing: the active workspace's reopen claim (via
        // its command registration) outranks the shell's new-terminal owner.
        // Read the registration map synchronously because the workspace can
        // publish a newly available claim during the same interaction in
        // which the user closes the last editor tab.
        const currentActiveTabId = useAppStore.getState().activeTabId;
        const registration = currentActiveTabId
          ? workspaceCommandRegistrationsRef.current[currentActiveTabId] ?? null
          : null;
        const route = resolveShellShortcutRoute(registration?.shellShortcutClaims ?? []);
        if (route.state === "dispatch") {
          event.preventDefault();
          event.stopPropagation();
          void registration?.executeAction(route.actionId);
          return;
        }
        if (route.state === "blocked") {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        handleCommand("new-terminal");
        return;
      }

      const state = useAppStore.getState();
      const current = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (current?.type === "welcome") {
        // If a code-workspace tab exists, switch to it and let its Go to File
        // handler execute Ctrl+Shift+N instead of creating a new session.
        const workspaceTab = state.tabs.find((tab) => tab.type === "code-workspace");
        if (workspaceTab) {
          event.preventDefault();
          event.stopPropagation();
          setActiveTab(workspaceTab.id);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        handleCommand("new-session");
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [handleCommand, setActiveTab]);
}
