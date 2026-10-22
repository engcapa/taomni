import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { type SessionConfig } from "../../lib/ipc";
import { type TerminalProfile } from "../../lib/terminalProfile";
import type { LocalLaunchOutcome, LocalShellSelection } from "../../types";
import { type ResumeQueueContext, type ConnectQueueOutcome, type ControlToolDispatch } from "./types";
import { controlLocalShellSelection } from "./controlArguments";



export interface ExecuteControlToolContext {
  tabsRef: import("react").RefObject<Tab[]>;
  loadSessions: () => Promise<void>;
  openQueuedSession: (session: SessionConfig, localShellOverride?: LocalShellSelection, resume?: ResumeQueueContext) => ConnectQueueOutcome;
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
}


export function createExecuteControlTool(controllerContext: ExecuteControlToolContext): (dispatch: ControlToolDispatch) => Promise<void> {
  return async (dispatch: ControlToolDispatch) => {
    let ok = false;
    let output = "";
    const args = dispatch.args ?? {};
    const resolveTab = (raw: unknown): Tab | undefined => {
      const id = String(raw ?? "").trim();
      if (!id) return undefined;
      return controllerContext.tabsRef.current.find((tab) => tab.id === id);
    };
    const resolveSession = async (): Promise<SessionConfig | null> => {
      const sessionId = String(args.session_id ?? "").trim();
      if (sessionId) {
        let found = useSessionStore.getState().sessions.find((s) => s.id === sessionId) ?? null;
        if (!found) {
          await controllerContext.loadSessions();
          found = useSessionStore.getState().sessions.find((s) => s.id === sessionId) ?? null;
        }
        return found;
      }
      const query = String(args.query ?? "").trim().toLowerCase();
      if (!query) return null;
      let all = useSessionStore.getState().sessions;
      if (all.length === 0) {
        await controllerContext.loadSessions();
        all = useSessionStore.getState().sessions;
      }
      const matches = all.filter((s) =>
        s.id.toLowerCase() === query ||
        s.name.toLowerCase().includes(query) ||
        s.host.toLowerCase().includes(query)
      );
      return matches.length === 1 ? matches[0] : null;
    };

    try {
      switch (dispatch.tool) {
        case "session_open": {
          const session = await resolveSession();
          if (!session) {
            output = "session_open could not resolve a unique session";
            break;
          }
          const localShell = controlLocalShellSelection(args);
          if (localShell.error) {
            output = localShell.error;
            break;
          }
          if (localShell.localShell && session.session_type !== "LocalShell") {
            output = "local_shell only applies to saved LocalShell sessions";
            break;
          }
          const outcome = controllerContext.openQueuedSession(session, localShell.localShell);
          if (outcome === "opened") {
            ok = true;
            output = `opened session ${session.id}`;
          } else {
            ok = true;
            output = `session ${session.id} queued: ${outcome}`;
          }
          break;
        }
        case "session_open_editor": {
          const sessionId = String(args.session_id ?? "").trim();
          if (sessionId) {
            const session = await resolveSession();
            if (!session) {
              output = `session not found: ${sessionId}`;
              break;
            }
            controllerContext.setEditingSession(session);
            controllerContext.setNewSessionGroupPath(null);
            controllerContext.setNewSessionInitialProto(undefined);
          } else {
            controllerContext.setEditingSession(undefined);
            controllerContext.setNewSessionGroupPath(typeof args.group_path === "string" ? args.group_path : null);
            controllerContext.setNewSessionInitialProto(typeof args.session_type === "string" ? args.session_type : undefined);
          }
          controllerContext.setShowSessionEditor(true);
          ok = true;
          output = "session editor opened";
          break;
        }
        case "quick_connect": {
          const input = String(args.input ?? "").trim();
          if (!input) {
            output = "quick_connect requires input";
            break;
          }
          controllerContext.handleQuickConnect(input);
          ok = true;
          output = "quick connect submitted";
          break;
        }
        case "tab_list": {
          const tabs = useAppStore.getState().tabs.map((tab, index) => ({
            id: tab.id,
            title: tab.title,
            type: tab.type,
            sessionId: tab.sessionId ?? null,
            active: tab.id === useAppStore.getState().activeTabId,
            index,
          }));
          ok = true;
          output = JSON.stringify(tabs, null, 2);
          break;
        }
        case "tab_switch": {
          const tab = resolveTab(args.tab_id);
          if (!tab) {
            output = `tab not found: ${String(args.tab_id ?? "")}`;
            break;
          }
          controllerContext.setActiveTab(tab.id);
          ok = true;
          output = `switched to tab ${tab.id}`;
          break;
        }
        case "tab_duplicate": {
          const tab = resolveTab(args.tab_id);
          if (!tab) {
            output = `tab not found: ${String(args.tab_id ?? "")}`;
            break;
          }
          await controllerContext.handleDuplicateTab(tab.id);
          ok = true;
          output = `duplicated tab ${tab.id}`;
          break;
        }
        case "tab_rename": {
          const tab = resolveTab(args.tab_id);
          const title = String(args.title ?? "").trim();
          if (!tab || !title) {
            output = "tab_rename requires a valid tab_id and title";
            break;
          }
          controllerContext.updateTabTitle(tab.id, title);
          ok = true;
          output = `renamed tab ${tab.id}`;
          break;
        }
        case "tab_close": {
          const tab = resolveTab(args.tab_id);
          if (!tab) {
            output = `tab not found: ${String(args.tab_id ?? "")}`;
            break;
          }
          if (!tab.closable) {
            output = `tab is not closable: ${tab.id}`;
            break;
          }
          controllerContext.removeTab(tab.id);
          ok = true;
          output = `closed tab ${tab.id}`;
          break;
        }
        case "tab_move": {
          const tab = resolveTab(args.tab_id);
          const toIndex = Number(args.to_index);
          if (!tab || !Number.isInteger(toIndex)) {
            output = "tab_move requires a valid tab_id and integer to_index";
            break;
          }
          controllerContext.moveTabToIndex(tab.id, toIndex);
          ok = true;
          output = `moved tab ${tab.id} to index ${toIndex}`;
          break;
        }
        case "tab_open_settings": {
          controllerContext.openSettingsTab();
          ok = true;
          output = "settings tab opened";
          break;
        }
        case "tab_open_local_terminal": {
          const localShell = controlLocalShellSelection(args);
          if (localShell.error) {
            output = localShell.error;
            break;
          }
          controllerContext.openLocalTab(
            typeof args.title === "string" ? args.title : localShell.localShell?.name,
            undefined,
            undefined,
            localShell.localShell,
          );
          ok = true;
          output = "local terminal opened";
          break;
        }
        case "tab_open_file_browser": {
          const path = String(args.path ?? "").trim();
          if (!path) {
            output = "tab_open_file_browser requires path";
            break;
          }
          controllerContext.openFileBrowserTab(typeof args.title === "string" ? args.title : path, path);
          ok = true;
          output = `file browser opened: ${path}`;
          break;
        }
        default:
          output = `unsupported control tool: ${dispatch.tool}`;
      }
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
    }

    try {
      await invoke("cc_resolve_tool_call", {
        callId: dispatch.callId,
        ok,
        output,
      });
    } catch (err) {
      console.error("cc_resolve_tool_call failed:", err);
    }
  };
}
