import { invoke } from "@tauri-apps/api/core";
import { writeText } from "../clipboard";

/**
 * Inject a shell command into the active terminal session.
 * Appends a newline so the command executes immediately.
 */
export async function executeCommandInTerminal(
  sessionId: string,
  command: string,
): Promise<void> {
  const withNewline = command.endsWith("\n") ? command : command + "\n";
  const encoded = btoa(unescape(encodeURIComponent(withNewline)));
  await invoke("write_terminal", { id: sessionId, data: encoded });
}

/**
 * Copy a command to the clipboard.
 */
export async function copyCommandToClipboard(command: string): Promise<void> {
  await writeText(command);
}

/**
 * Update the audit log outcome after user action.
 */
export async function updateAuditOutcome(
  auditId: number,
  outcome: "executed" | "edited" | "cancelled" | "blocked_blacklist",
): Promise<void> {
  await invoke("update_shell_audit_outcome", { auditId, outcome });
}
