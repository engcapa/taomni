import { t } from "../../../lib/i18n";
import { type SqlEcho } from "./types";
import { uploadLocalPaths } from "./uploadPlanning";



/** Zero-padded HH:MM:SS for the echoed comment. */
export function clockHms(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}



/** Build the SQL comment line prepended above an echoed statement. */
export function buildEchoNote(e: SqlEcho): string {
  const parts = [`Claude Code ${clockHms(new Date())}`];
  if (e.ok) {
    parts.push(e.captured ? "captured" : "ok");
    parts.push(`${e.rowCount} rows`);
    if (e.rowsAffected > 0) parts.push(`${e.rowsAffected} affected`);
    parts.push(`${e.durationMs}ms`);
  } else {
    parts.push(`error: ${(e.error ?? "failed").replace(/\s+/g, " ").slice(0, 200)}`);
  }
  return `-- ⟦${parts.join(" · ")}⟧`;
}



/** Human-readable byte size for the capture progress card. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}



export const LARGE_UPLOAD_THRESHOLD_BYTES = 60 * 1024 * 1024;



/** Short human description of what a tool call will do, for the ActionCard. */
export function describe(tool: string, rawArgs: Record<string, unknown> | null | undefined): string {
  const args = rawArgs ?? {};
  switch (tool) {
    case "run_in_terminal":
    case "Bash":
      return t("agent.toolRequest.terminal", { command: String(args.command ?? "") });
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return t("agent.toolRequest.edit", { path: String(args.file_path ?? args.notebook_path ?? "") });
    case "sftp_upload": {
      const localPaths = uploadLocalPaths(args);
      const remote = String(args.remote_path ?? args.remote_dir ?? "");
      if (localPaths.length > 1) return t("agent.toolRequest.uploadMany", { count: localPaths.length, remote });
      return t("agent.toolRequest.upload", { path: localPaths[0] ?? String(args.local_path ?? ""), remote });
    }
    case "sftp_download":
      return t("agent.toolRequest.download", { path: String(args.local_dir ?? "") });
    case "save_as_runbook":
      return t("agent.toolRequest.runbook", { name: String(args.name ?? "") });
    case "run_sql":
    case "run_sql_captured":
      return t("agent.toolRequest.sql", { sql: String(args.sql ?? "") });
    case "export_result":
      return t("agent.toolRequest.exportResult", { format: String(args.format ?? "csv") });
    case "redis_set_key":
      return t("agent.toolRequest.redisSet", { key: String(args.key ?? "") });
    case "redis_del_key":
      return t("agent.toolRequest.redisDelete", { key: String(args.key ?? "") });
    case "redis_exec":
      return t("agent.toolRequest.redisExec", { command: String(args.command ?? "") });
    default:
      return t("agent.toolRequest.other", { tool });
  }
}



/** The most useful preview string for a tool call (command / path / sql), if any. */
export function preview(rawArgs: Record<string, unknown> | null | undefined): string | null {
  const args = rawArgs ?? {};
  if (typeof args.command === "string") return args.command;
  if (typeof args.sql === "string") return args.sql;
  if (typeof args.file_path === "string") return args.file_path;
  const uploadPaths = uploadLocalPaths(args);
  if (uploadPaths.length > 0) return uploadPaths.join(", ");
  if (typeof args.remote_path === "string") return args.remote_path;
  return null;
}
