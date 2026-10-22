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
      return `在终端执行命令: ${String(args.command ?? "")}`;
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `修改文件: ${String(args.file_path ?? args.notebook_path ?? "")}`;
    case "sftp_upload": {
      const localPaths = uploadLocalPaths(args);
      const remote = String(args.remote_path ?? args.remote_dir ?? "");
      if (localPaths.length > 1) return `上传 ${localPaths.length} 个本地文件到 ${remote}`;
      return `上传 ${localPaths[0] ?? String(args.local_path ?? "")} 到 ${remote}`;
    }
    case "sftp_download":
      return `下载远端文件到 ${String(args.local_dir ?? "")}`;
    case "save_as_runbook":
      return `保存 Runbook: ${String(args.name ?? "")}`;
    case "run_sql":
    case "run_sql_captured":
      return `执行 SQL: ${String(args.sql ?? "")}`;
    case "export_result":
      return `导出查询结果 (${String(args.format ?? "csv")})`;
    case "redis_set_key":
      return `写入 Redis 键: ${String(args.key ?? "")}`;
    case "redis_del_key":
      return `删除 Redis 键: ${String(args.key ?? "")}`;
    case "redis_exec":
      return `执行 Redis 命令: ${String(args.command ?? "")}`;
    default:
      return `Claude Code 请求执行工具 "${tool}"`;
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
