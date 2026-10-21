import { type QueryExecutionSummary } from "./types";


export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}


export function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}


export function formatFullDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatClockTime(timestamp)}`;
}


export function formatDurationMs(durationMs: number | null | undefined): string | null {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) return null;
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${ms} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}


export function successMessage(summary: QueryExecutionSummary): string {
  if (summary.hasResultSet) {
    const rows = summary.rowCount ?? 0;
    return `${rows} row${rows === 1 ? "" : "s"} fetched`;
  }
  const affected = summary.rowsAffected ?? 0;
  return affected === 0 ? "OK. No rows were affected" : `${affected} row${affected === 1 ? "" : "s"} affected`;
}
