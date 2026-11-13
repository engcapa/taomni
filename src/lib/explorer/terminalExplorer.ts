import { alertAppDialog } from "../appDialogs";
import { t } from "../i18n";
import { openExplorer } from "./openExplorer";
import { useAppStore } from "../../stores/appStore";

/** Resolve at activation, not menu creation, so a recent `cd` wins. */
export async function openTerminalExplorer(
  resolveCwd: () => Promise<string | null | undefined>,
  forceNew = false,
  workspaceId?: string,
): Promise<void> {
  try {
    const cwd = (await resolveCwd())?.trim();
    if (!cwd) {
      await alertAppDialog({ title: t("menu.fileExplorer"), message: t("explorerEntry.cwdUnavailable") });
      return;
    }
    await openExplorer(cwd, { workspaceId, forceNew });
  } catch (error) {
    useAppStore.getState().setStatusMessage(String(error));
  }
}
