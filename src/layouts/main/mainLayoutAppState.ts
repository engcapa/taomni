import type { AppState } from "../../stores/appStore";

// Editor context, diagnostics and status have their own consumers. Publishing
// them must not synchronously render the whole window and its hidden surfaces.
const MAIN_LAYOUT_KEYS = [
  "tabs",
  "activeTabId",
  "sidebarCollapsed",
  "mergeToolWindowRail",
  "xServerEnabled",
  "refreshXServer",
  "addTab",
  "removeTab",
  "duplicateTab",
  "updateTabTitle",
  "assignTerminalAutoTitle",
  "updateGitTabInfo",
  "setActiveTab",
  "moveTabToIndex",
  "toggleSidebar",
  "setSidebarCollapsed",
  "setActiveSideTab",
  "toggleXServer",
  "setStatusMessage",
  "multiExecActive",
  "multiExecSelectedTabIds",
  "terminalSplitActive",
  "terminalSplitLayout",
  "terminalSplitInputLockedTabIds",
  "terminalRuntimeByTab",
  "welcomeRecentSessionLimit",
  "toggleMultiExec",
  "selectAllTerminalTabs",
  "clearMultiExecSelection",
  "setTerminalSplitActive",
  "toggleTerminalSplit",
  "setTerminalSplitLayout",
  "toggleTerminalSplitInputLock",
  "clearTerminalSplitInputLocks",
  "setTabHasNewOutput",
  "removeRecentWorkspace",
  "clearRecentWorkspaces",
] as const satisfies readonly (keyof AppState)[];

type MainLayoutAppState = Pick<AppState, typeof MAIN_LAYOUT_KEYS[number]>;

export function selectMainLayoutAppState(state: AppState): MainLayoutAppState {
  return Object.fromEntries(MAIN_LAYOUT_KEYS.map((key) => [key, state[key]])) as MainLayoutAppState;
}
