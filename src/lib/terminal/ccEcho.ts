/**
 * Renders a Claude Code captured-run (`run_captured`) into a compact, read-only
 * ANSI trace block for the bound terminal.
 *
 * The default `run_captured` path (reflect_session=false) runs in an independent
 * SSH exec channel / local child — fully captured but invisible in the live
 * terminal. To keep the user in the loop, the backend emits an
 * `agent-cc-terminal-echo` event after each such run; this turns it into a
 * framed trace (command header + a head of the output + a dim stats footer)
 * that `CcAgentBridge` paints into the bound terminal via `writeEcho`.
 *
 * Pure (no DOM / no xterm) so it is unit-testable. Output uses `\r\n` line ends
 * because it is written straight into xterm.
 */

/** Payload of the backend `agent-cc-terminal-echo` event (B-path only). */
export interface CcTerminalEcho {
  /** Terminal *tab id* (frontend registry key) the trace belongs to. */
  sessionId: string;
  threadId: string;
  captureId: string;
  /** The command that was run. */
  command: string;
  /** Head slice of the captured output (first ~SUMMARY_HEAD lines). */
  head: string;
  /** Total lines captured (may exceed what `head` shows). */
  lines: number;
  /** Total bytes captured (approximate). */
  bytes: number;
  /** True when a capture cap stopped collection before the command finished. */
  truncated: boolean;
  /** Command exit code, when known. */
  exitCode: number | null;
  /** Capture status: "Done" | "Failed" | "Cancelled" | "TimedOut" | "Running". */
  status: string;
}

const RESET = "\x1b[0m";
const HEADER = "\x1b[1;36m"; // bold cyan
const DIM = "\x1b[2m";

/** Human-readable byte size. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Chinese label for a non-success capture status (empty for Done/Running). */
function statusLabel(status: string): string {
  switch (status) {
    case "Failed":
      return "失败";
    case "Cancelled":
      return "已取消";
    case "TimedOut":
      return "超时";
    default:
      return "";
  }
}

/** Split captured text into display lines, dropping a single trailing blank. */
function toLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r?\n+$/g, "").split(/\r?\n/);
}

/**
 * Build the ANSI trace block for one captured run. Leads and trails with
 * `\r\n` so it lands on its own lines regardless of where the live cursor was.
 */
export function formatCcTerminalEcho(p: CcTerminalEcho): string {
  // Collapse newlines in the command so the header stays a single line.
  const cmd = (p.command ?? "").replace(/\r?\n/g, " ").trim();
  const headLines = toLines(p.head ?? "");

  const out: string[] = [];
  out.push(`${HEADER}┃ [CC] $ ${cmd}${RESET}`);
  out.push(...headLines);

  // --- footer: status · exit · size · hidden-lines/truncation hint ---------
  const parts: string[] = [];
  const sl = statusLabel(p.status);
  if (sl) parts.push(sl);
  parts.push(`exit=${p.exitCode ?? "?"}`);
  if (headLines.length === 0) {
    parts.push("无输出");
  } else {
    parts.push(`共 ${p.lines} 行`);
    parts.push(fmtBytes(p.bytes));
  }
  const hidden = Math.max(0, p.lines - headLines.length);
  if (hidden > 0) parts.push(`+${hidden} 行未显示`);
  if (p.truncated) parts.push("已截断");
  if (hidden > 0 || p.truncated) parts.push("完整见对话 / read_capture");

  out.push(`${DIM}┃ [CC] ${parts.join(" · ")}${RESET}`);

  return `\r\n${out.join("\r\n")}\r\n`;
}
