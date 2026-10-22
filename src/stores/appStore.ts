import { create } from "zustand";
import { type AppState } from "./app/types";
import { createTabsSlice } from "./app/tabsSlice";
import { createLayoutSlice } from "./app/layoutSlice";
import { createTerminalSlice } from "./app/terminalSlice";
import { createAppearanceSlice } from "./app/appearanceSlice";
import { createWorkspaceSlice } from "./app/workspaceSlice";
import { createDatabaseSlice } from "./app/databaseSlice";
import { UI_FONT_FAMILY_KEY, readUiFontFamily, UI_FONT_SIZE_KEY, readUiFontSize, clampUiFontSize } from "./app/preferences";

export { computeDuplicateTitle, computeNewTerminalTitle, updateDuplicateAutoTitle } from "./app/tabTitles";

export const useAppStore = create<AppState>((...args) => ({
  ...createTabsSlice(...args),
  ...createLayoutSlice(...args),
  ...createTerminalSlice(...args),
  ...createAppearanceSlice(...args),
  ...createWorkspaceSlice(...args),
  ...createDatabaseSlice(...args),
}));

export function syncUiAppearanceFromStorage(event: Pick<StorageEvent, "key" | "newValue">): void {
  if (event.key === null || event.key === UI_FONT_FAMILY_KEY) {
    const uiFontFamily = event.key === UI_FONT_FAMILY_KEY && event.newValue
      ? event.newValue
      : readUiFontFamily();
    useAppStore.setState({ uiFontFamily });
  }

  if (event.key === null || event.key === UI_FONT_SIZE_KEY) {
    const parsed = event.key === UI_FONT_SIZE_KEY && event.newValue !== null
      ? Number.parseInt(event.newValue, 10)
      : readUiFontSize();
    const uiFontSize = Number.isFinite(parsed)
      ? clampUiFontSize(parsed)
      : readUiFontSize();
    useAppStore.setState({ uiFontSize });
  }
}

export function subscribeUiAppearanceStorage(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handleStorage = (event: StorageEvent) => syncUiAppearanceFromStorage(event);
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}

export {
  type SideTab,
  type TerminalSplitLayout,
  type VaultUnlockMode,
  type DbObjectKind,
  type DbSelectedObject,
  type CodeWorkspaceContext,
  type TerminalActivityState,
  type TerminalRuntimeInfo,
  type CodeWorkspaceRootContext,
  type CodeWorkspaceLooseFileContext,
  type CodeWorkspaceFileContext,
  type CodeWorkspaceLspContext,
  type CodeWorkspaceLspStatusContext,
  type CodeWorkspaceLspDiagnosticContext,
  type AppState,
} from "./app/types";

export { VAULT_UNLOCK_MODE_KEY } from "./app/preferences";

export { recentWorkspaceIdFromParts, newWorkspaceInstanceId } from "./app/recentWorkspaces";
