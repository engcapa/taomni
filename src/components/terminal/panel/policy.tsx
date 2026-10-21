import { Terminal } from "@xterm/xterm";
import { parseSessionOptions } from "../../../lib/terminalProfile";
import { getAppPlatform, isTauriRuntime } from "../../../lib/runtime";
import { type SshConnectInfo, type TerminalBlockSelectionCell } from "./types";


export const DEFAULT_FONT_SIZE = 14;


export const ERASE_SAVED_LINES_SEQUENCE = [0x1b, 0x5b, 0x33, 0x4a] as const;


export function formatSshInfoBanner(ssh: SshConnectInfo): string {
  const options = parseSessionOptions(ssh.optionsJson);
  const compression = options.compression === true;
  const x11 = options.x11 !== false;
  const sshBrowser = typeof options.sshBrowser === "string" ? options.sshBrowser : "SFTP protocol (recommended)";
  const sshBrowserEnabled = sshBrowser !== "Disabled";
  const rows = [
    "Taomni SSH terminal",
    "SSH session to " + ssh.username + "@" + ssh.host,
    "Direct SSH      : " + checkMark(true),
    "SSH compression : " + checkMark(compression),
    "SSH-browser     : " + checkMark(sshBrowserEnabled) + (sshBrowserEnabled ? "  " + sshBrowser : ""),
    "X11-forwarding  : " + checkMark(x11) + (x11 ? "  (remote display is forwarded through SSH)" : ""),
    "",
    "For more info, edit SSH session advanced settings.",
  ];
  const width = Math.max(68, ...rows.map((row) => row.length + 4));
  const border = "+" + "-".repeat(width - 2) + "+";
  const body = rows.map((row) => "| " + row.padEnd(width - 4) + " |");
  return "\r\n" + [border, ...body, border].join("\r\n") + "\r\n";
}


export function checkMark(enabled: boolean): string {
  return enabled ? "✓" : "✗";
}


export function terminalCursorCell(term: Terminal): TerminalBlockSelectionCell | null {
  const buffer = term.buffer.active;
  if (buffer.length === 0) return null;
  return {
    row: Math.max(0, Math.min(buffer.length - 1, buffer.baseY + buffer.cursorY)),
    col: Math.max(0, Math.min(term.cols - 1, buffer.cursorX)),
  };
}


export function currentTerminalSize(term: Pick<Terminal, "cols" | "rows"> | null): { cols: number; rows: number } {
  return {
    cols: Math.max(2, Math.floor(term?.cols || 80)),
    rows: Math.max(1, Math.floor(term?.rows || 24)),
  };
}


export function isMacPrintableOptionInput(event: KeyboardEvent): boolean {
  return (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing &&
    event.key.length === 1 &&
    event.key.charCodeAt(0) >= 0x20 &&
    event.key !== " "
  );
}


export function isTerminalBlockSelectionMouseEvent(
  event: Pick<MouseEvent, "button" | "altKey" | "ctrlKey" | "shiftKey">,
): boolean {
  return event.button === 0 && (event.altKey || (event.ctrlKey && event.shiftKey));
}


export function terminalCellFromMouseEvent(
  term: Terminal,
  container: HTMLDivElement,
  event: Pick<MouseEvent, "clientX" | "clientY">,
): TerminalBlockSelectionCell | null {
  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen || term.cols <= 0 || term.rows <= 0 || term.buffer.active.length <= 0) return null;

  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const cellWidth = rect.width / term.cols;
  const cellHeight = rect.height / term.rows;
  const visibleCol = Math.floor((event.clientX - rect.left) / cellWidth);
  const visibleRow = Math.floor((event.clientY - rect.top) / cellHeight);
  const col = Math.max(0, Math.min(term.cols - 1, visibleCol));
  const row = Math.max(
    0,
    Math.min(term.buffer.active.length - 1, term.buffer.active.viewportY + Math.max(0, Math.min(term.rows - 1, visibleRow))),
  );

  return { row, col };
}


export function normalizePasteText(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}


export function shouldUseTerminalWebgl(enabled: boolean): boolean {
  if (!enabled) return false;
  // Tauri uses WKWebView on macOS. On Intel/older macOS builds the WebGL
  // renderer can flash, lose context, or leave the terminal blank, while
  // xterm's default renderer stays stable for PTY/SSH output.
  return !(isTauriRuntime() && getAppPlatform() === "macos");
}


export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
