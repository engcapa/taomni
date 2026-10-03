import {
  type ExecutionLogEntry,
  type ExecutionLogRun,
  type ExecutionLogStatus,
  formatExecutionClock,
  formatExecutionDuration,
  summarizeExecutionRun,
} from "../../lib/dbExecutionLog";

const STATUS_LABEL: Record<ExecutionLogStatus, string> = {
  running: "RUNNING",
  success: "SUCCESS",
  failed: "FAILED",
  cancelled: "CANCELLED",
  skipped: "SKIPPED",
  "not-run": "NOT RUN",
};

const STATUS_COLOR: Record<ExecutionLogStatus, string> = {
  running: "var(--taomni-accent)",
  success: "#3fa652",
  failed: "#d9534f",
  cancelled: "#e6a817",
  skipped: "#e6a817",
  "not-run": "var(--taomni-text-muted)",
};

function rowsLabel(entry: ExecutionLogEntry): string {
  if (entry.rowCount !== null && entry.rowCount > 0) return String(entry.rowCount);
  if (entry.rowsAffected !== null) return String(entry.rowsAffected);
  return entry.rowCount === null ? "" : "0";
}

function summaryText(run: ExecutionLogRun): string {
  const summary = summarizeExecutionRun(run);
  const parts = [`Success: ${summary.success}`, `Failed: ${summary.failed}`];
  if (summary.skipped > 0) parts.push(`Skipped: ${summary.skipped}`);
  if (summary.cancelled > 0) parts.push(`Cancelled: ${summary.cancelled}`);
  if (summary.notRun > 0) parts.push(`Not run: ${summary.notRun}`);
  if (summary.running > 0) parts.push(`Running: ${summary.running}`);
  parts.push(`Total: ${formatExecutionDuration(summary.durationMs) || "0 ms"}`);
  return parts.join(" · ");
}

export function ExecutionLogView({
  runs,
  onSelectSheet,
}: {
  runs: ExecutionLogRun[];
  onSelectSheet: (sheetId: string) => void;
}) {
  const cell = "px-2 py-0.5 align-top whitespace-nowrap";
  if (runs.length === 0) {
    return (
      <div data-testid="db-execution-log" className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
        No statements executed yet.
      </div>
    );
  }
  return (
    <div
      data-testid="db-execution-log"
      className="flex-1 min-h-0 overflow-auto taomni-scroll-y text-[11px] font-mono"
      style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
    >
      <table className="w-full border-collapse">
        <thead className="sticky top-0" style={{ background: "var(--taomni-chrome-bg)" }}>
          <tr className="text-left text-[var(--taomni-text-muted)]">
            <th className={cell}>#</th>
            <th className={cell}>Status</th>
            <th className={cell}>Time</th>
            <th className={cell}>Duration</th>
            <th className={cell}>Rows</th>
            <th className={cell}>Message</th>
            <th className={cell}>SQL</th>
          </tr>
        </thead>
        {runs.map((run) => (
          <tbody key={run.id} data-testid="db-execution-log-run" data-run-id={run.id}>
            {run.entries.map((entry) => (
              <tr
                key={entry.id}
                data-testid="db-execution-log-entry"
                data-status={entry.status}
                style={{ borderTop: "1px solid var(--taomni-divider)" }}
              >
                <td className={cell}>{entry.ordinal}</td>
                <td className={cell} style={{ color: STATUS_COLOR[entry.status] }}>
                  {STATUS_LABEL[entry.status]}
                </td>
                <td className={cell}>{formatExecutionClock(entry.startedAt)}</td>
                <td className={cell}>{formatExecutionDuration(entry.durationMs)}</td>
                <td className={cell}>{rowsLabel(entry)}</td>
                <td
                  className="px-2 py-0.5 align-top whitespace-pre-wrap break-words max-w-[420px]"
                  style={{ color: entry.status === "failed" ? "#d9534f" : undefined }}
                  data-testid="db-execution-log-message"
                >
                  {entry.message ?? ""}
                </td>
                <td className="px-2 py-0.5 align-top max-w-[420px] truncate" title={entry.sql}>
                  {entry.sheetId ? (
                    <button
                      type="button"
                      className="truncate max-w-full text-left hover:underline"
                      onClick={() => onSelectSheet(entry.sheetId as string)}
                    >
                      {entry.sql.replace(/\s+/g, " ")}
                    </button>
                  ) : (
                    entry.sql.replace(/\s+/g, " ")
                  )}
                </td>
              </tr>
            ))}
            <tr style={{ borderTop: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}>
              <td className={cell} colSpan={7} data-testid="db-execution-log-summary">
                {formatExecutionClock(run.startedAt)} · {summaryText(run)}
              </td>
            </tr>
          </tbody>
        ))}
      </table>
    </div>
  );
}
