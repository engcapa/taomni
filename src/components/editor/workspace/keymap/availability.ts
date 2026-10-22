import { type ActionDisabledReason } from "../workspaceActionRegistry";

/** Disabled-reason display policy shared by Keymap/Search surfaces. */
export function disabledReasonLabel(reason: ActionDisabledReason | undefined): string | null {
  switch (reason) {
    case "userDisabled": return "Disabled in Keymap";
    case "readOnly": return "Read-only file";
    case "noEditor": return "No active editor";
    case "noSelection": return "No selection";
    case "providerOffline": return "Language server offline";
    case "conflict": return "Binding conflict";
    case "busy": return "Already running";
    case "loading": return "File is still loading";
    case "unsupported": return "Not supported yet";
    default: return null;
  }
}
