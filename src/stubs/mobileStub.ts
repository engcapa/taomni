// Browser preview only: no native listener is created by these settings stubs.
import { feishuStub } from "./feishuStub";
interface Status { enabled: boolean; address: string | null; failed_attempts: number; devices: unknown[]; allow_open_sessions: boolean }
let status: Status = { enabled: false, address: null, failed_attempts: 0, devices: [], allow_open_sessions: false };
export async function mobileStub(command: string, args?: Record<string, unknown>) {
  if (command.startsWith("mobile_feishu_")) return feishuStub(command, args);
  if (command === "mobile_start") status = { ...status, enabled: true, address: `http://127.0.0.1:${args?.port || 8787}` };
  if (command === "mobile_stop") status = { ...status, enabled: false, address: null };
  if (command === "mobile_pairing_code") return "preview-only-pairing-code";
  if (command === "mobile_revoke") return;
  if (command === "mobile_set_open_sessions") { status = { ...status, allow_open_sessions: !!args?.enabled }; return status.allow_open_sessions; }
  if (command === "mobile_claim_open_session") return status.enabled && status.allow_open_sessions;
  if (command === "mobile_terminal_title" || command === "mobile_open_session_result") return true;
  return structuredClone(status);
}
