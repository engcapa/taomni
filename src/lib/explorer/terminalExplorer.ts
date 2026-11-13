import { alertAppDialog } from "../appDialogs";
import { t } from "../i18n";
import { openExplorer } from "./openExplorer";
import { useAppStore } from "../../stores/appStore";
import { getAppPlatform } from "../runtime";
import { normalizeLocalStartCwd } from "../terminalCwd";

/** Resolve at activation, not menu creation, so a recent `cd` wins. */
export async function openTerminalExplorer(
  resolveCwd: () => Promise<string | null | undefined>,
  forceNew = false,
  workspaceId?: string,
): Promise<void> {
  try {
    const reported = (await resolveCwd())?.trim();
    // PowerShell OSC 7 URI paths use /D:/...; only the local-terminal entry
    // normalizes that shape, never general Explorer input or remote SSH cwd.
    const cwd = reported ? normalizeLocalStartCwd(reported, getAppPlatform()) : null;
    if (!cwd) {
      await alertAppDialog({ title: t("menu.fileExplorer"), message: t("explorerEntry.cwdUnavailable") });
      return;
    }
    await openExplorer(cwd, { workspaceId, forceNew });
  } catch (error) {
    useAppStore.getState().setStatusMessage(String(error));
  }
}
