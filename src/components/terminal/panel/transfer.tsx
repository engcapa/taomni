import { Terminal } from "@xterm/xterm";
import { type TerminalProfile } from "../../../lib/terminalProfile";
import { normalizePasteText } from "./policy";


export function terminalCanPromptForLocalPathUpload(term: Terminal | null): boolean {
  if (!term) return false;
  if (term.buffer.active.type === "alternate") return false;
  return true;
}


export function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}


// When the running app has enabled DEC bracketed paste (CSI ?2004h), wrap the
// payload so the app can distinguish a paste from typed input. The LFs inside
// the envelope are preserved on purpose: modern TUIs (Claude Code, ipython,
// nano, lazygit, ...) read \n as "newline inside the paste" and \r as "submit",
// and on Windows ConPTY there is no termios ICRNL to translate \r→\n the way
// Linux PTYs do. Without this wrapping a 9-line paste arrives as 9 separate
// Enter presses on Windows.
export function formatPasteForTerminal(term: Terminal | null, text: string): string {
  if (term?.modes.bracketedPasteMode) {
    return `\x1b[200~${text.replace(/\r\n/g, "\n")}\x1b[201~`;
  }
  return normalizePasteText(text);
}


export function downloadTextFile(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}


export function timestampFilePart(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}


export function safeFilePart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "terminal";
}


export function terminalProfileSignature(profile: TerminalProfile): string {
  return JSON.stringify(profile);
}
