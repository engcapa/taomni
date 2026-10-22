
/**
 * Bridges local agent human-in-the-loop events to the UI.
 *
 * - `agent-cc-permission`: CC asked to run a write/side-effect tool. We surface
 *   an ActionCard; the user's choice is sent back via `cc_resolve_permission`,
 *   unblocking the server's `permission_prompt` handler.
 * - `agent-acp-permission`: an ACP agent (such as Grok CLI) requested native
 *   tool permission. We show locally trusted labels for standard ACP choices
 *   and return the selected opaque option id via `acp_resolve_permission`.
 * - `agent-cc-tool`: an approved Taomni side-effect tool needs the frontend to
 *   perform the effect (e.g. write a command into the linked SSH terminal). The
 *   outcome is returned via `cc_resolve_tool_call`.
 *
 * Mounted once at the app shell. Events only fire when a CC thread actually
 * drives a tool, so this is inert otherwise.
 */

export interface PermissionPrompt {
  callId: string;
  threadId: string;
  tool: string;
  args: Record<string, unknown>;
  trust: string;
}


export interface AcpPermissionOption {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}


export interface AcpPermissionPrompt {
  callId: string;
  threadId: string;
  permissionOwnerId: string;
  sourceLabel: string;
  title: string;
  kind: string;
  options: AcpPermissionOption[];
}


export interface AcpPermissionDismissed {
  threadId: string;
  permissionOwnerId?: string | null;
  callId?: string | null;
}


export type QueuedPermission =
  | ({ source: "cc" } & PermissionPrompt)
  | ({ source: "acp" } & AcpPermissionPrompt);


export interface ToolDispatch {
  callId: string;
  threadId: string;
  tool: string;
  args: Record<string, unknown>;
}


/** Live progress of an in-flight `run_captured` run (方案4). */
export interface CaptureProgress {
  captureId: string;
  threadId: string;
  lines: number;
  bytes: number;
}


/**
 * A statement CC just ran on a bound DB connection (`agent-cc-sql-echo`). When
 * SQL echo is enabled, the linked query tab appends it to a query editor.
 */
export interface SqlEcho {
  threadId: string;
  sql: string;
  ok: boolean;
  rowsAffected: number;
  rowCount: number;
  durationMs: number;
  captured: boolean;
  error?: string | null;
}


export interface AgentToolContext {
  threadId: string;
  callId: string;
  tool: string;
}


export interface SftpUploadPlan {
  name: string;
  localPath: string;
  remotePath: string;
  kind: "file" | "dir";
  size: number;
}
