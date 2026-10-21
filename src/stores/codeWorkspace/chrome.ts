import type { StoreApi } from "zustand";
import { createDefaultCodeWorkspaceUi } from "./defaults";
import { type CodeWorkspaceStoreState, DEFAULT_SHELL_CHROME_STATE, type ShellChromeState } from "./model";

export function createWorkspaceChromeActions(set: StoreApi<CodeWorkspaceStoreState>["setState"], get: StoreApi<CodeWorkspaceStoreState>["getState"]): Pick<CodeWorkspaceStoreState, "setShellChromeState" | "setBottomDockHeightForTool" | "restoreDefaultToolWindowLayout"> {
  return {

    setShellChromeState: (instanceId, patch) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const prevChrome = current.shellChromeState ?? DEFAULT_SHELL_CHROME_STATE;
        const nextChrome: ShellChromeState = {
          ...prevChrome,
          ...patch,
          bottomHeightByTool: {
            ...prevChrome.bottomHeightByTool,
            ...(patch.bottomHeightByTool ?? {}),
          },
        };
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              shellChromeState: nextChrome,
            },
          },
        };
      });
    },

    setBottomDockHeightForTool: (instanceId, toolId, height) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const prevChrome = current.shellChromeState ?? DEFAULT_SHELL_CHROME_STATE;
        const nextChrome: ShellChromeState = {
          ...prevChrome,
          bottomHeightPx: height,
          bottomHeightByTool: {
            ...prevChrome.bottomHeightByTool,
            [toolId]: height,
          },
        };
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              shellChromeState: nextChrome,
            },
          },
        };
      });
    },

    restoreDefaultToolWindowLayout: (instanceId) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              languagePanelOpen: true,
              bottomDockOpen: false,
              rightPaneOpen: false,
              shellChromeState: {
                ...DEFAULT_SHELL_CHROME_STATE,
                bottomHeightByTool: { ...DEFAULT_SHELL_CHROME_STATE.bottomHeightByTool },
              },
            },
          },
        };
      });
    }
  };
}
