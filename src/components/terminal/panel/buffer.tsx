import { type MutableRefObject } from "react";
import { Terminal, type IBufferLine } from "@xterm/xterm";
import { type TerminalSyntaxMode } from "../../../lib/terminalProfile";
import { extractTerminalCommand } from "../../../lib/terminalCommand";
import { type TerminalBlockSelection, type SearchMatch, type KeywordHighlight } from "./types";


export function getBufferText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];

  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;

    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
}


export function getLastBufferLines(term: Terminal, lineCount: number, end = term.buffer.active.length): string {
  const buffer = term.buffer.active;
  const total = Math.min(buffer.length, end);
  const start = Math.max(0, total - lineCount);
  const lines: string[] = [];
  for (let i = start; i < total; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}


/** Skip unused screen rows before selecting the tail, without scanning history. */
export function getTerminalPreviewText(term: Terminal, lineCount: number): string {
  const buffer = term.buffer.active;
  let end = buffer.length;
  while (end > buffer.baseY) {
    if (buffer.getLine(end - 1)?.translateToString(true).trim()) break;
    end -= 1;
  }
  return getLastBufferLines(term, lineCount, end);
}


export function collectTerminalBlockSelectionText(
  term: Pick<Terminal, "buffer" | "cols">,
  selection: TerminalBlockSelection,
): string {
  const range = normalizeTerminalBlockSelection(selection, term.cols);
  const lines: string[] = [];

  for (let row = range.startRow; row <= range.endRow; row += 1) {
    const line = term.buffer.active.getLine(row);
    const text = line ? line.translateToString(false) : "";
    lines.push(text.padEnd(range.endCol, " ").slice(range.startCol, range.endCol).trimEnd());
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}


export function normalizeTerminalBlockSelection(selection: TerminalBlockSelection, cols: number) {
  const startRow = Math.min(selection.anchor.row, selection.focus.row);
  const endRow = Math.max(selection.anchor.row, selection.focus.row);
  const startCol = Math.max(0, Math.min(selection.anchor.col, selection.focus.col));
  const endCol = Math.min(Math.max(startCol + 1, Math.max(selection.anchor.col, selection.focus.col) + 1), cols);
  return { startRow, endRow, startCol, endCol };
}


export function findAndSelectBufferText(
  term: Terminal,
  query: string,
  direction: "next" | "previous",
  searchRef: MutableRefObject<{ query: string; index: number }>,
): { index: number; total: number; matches: SearchMatch[] } | null {
  const matches = collectBufferMatches(term, query);
  if (matches.length === 0) {
    return null;
  }

  const sameQuery = searchRef.current.query === query;
  let nextIndex = sameQuery ? searchRef.current.index : -1;

  if (nextIndex < 0) {
    nextIndex = firstVisibleMatchIndex(term, matches, direction);
  } else {
    nextIndex = direction === "next"
      ? (nextIndex + 1) % matches.length
      : (nextIndex - 1 + matches.length) % matches.length;
  }

  const match = matches[nextIndex];
  term.scrollToLine(Math.max(0, match.row - Math.floor(term.rows / 2)));
  term.select(match.col, match.row, match.length);
  term.refresh(0, term.rows - 1);
  searchRef.current = { query, index: nextIndex };
  return { index: nextIndex, total: matches.length, matches };
}


export function collectBufferMatches(term: Terminal, query: string): SearchMatch[] {
  const buffer = term.buffer.active;
  const matches: SearchMatch[] = [];
  const needle = query.toLocaleLowerCase();

  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;

    const { text, stringIndexToCell } = lineToSearchText(line);
    const haystack = text.toLocaleLowerCase();
    let stringIndex = haystack.indexOf(needle);
    while (stringIndex !== -1) {
      const startCell = stringIndexToCell[stringIndex];
      const lastCell = stringIndexToCell[stringIndex + Math.max(needle.length - 1, 0)];
      if (typeof startCell === "number" && typeof lastCell === "number") {
        const lastWidth = line.getCell(lastCell)?.getWidth() || 1;
        matches.push({
          row,
          col: startCell,
          length: Math.max(1, lastCell + lastWidth - startCell),
        });
      }
      stringIndex = haystack.indexOf(needle, stringIndex + Math.max(needle.length, 1));
    }
  }

  return matches;
}


export function lineToSearchText(line: IBufferLine): { text: string; stringIndexToCell: number[] } {
  let text = "";
  const stringIndexToCell: number[] = [];

  for (let cellIndex = 0; cellIndex < line.length; cellIndex++) {
    const cell = line.getCell(cellIndex);
    if (!cell || cell.getWidth() === 0) continue;

    const chars = cell.getChars() || " ";
    for (let offset = 0; offset < chars.length; offset++) {
      stringIndexToCell[text.length + offset] = cellIndex;
    }
    text += chars;
  }

  const trimmedLength = text.trimEnd().length;
  return {
    text: text.slice(0, trimmedLength),
    stringIndexToCell: stringIndexToCell.slice(0, trimmedLength),
  };
}


export function captureBufferCommand(term: Terminal): string {
  const buffer = term.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY;

  // Walk up through wrapped lines to find the start of the logical row.
  let start = cursorRow;
  while (start > 0) {
    const line = buffer.getLine(start);
    if (line?.isWrapped) start -= 1;
    else break;
  }

  let text = "";
  for (let row = start; row <= cursorRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (row === cursorRow) {
      const segment = line.translateToString(false).slice(0, buffer.cursorX);
      text += segment;
    } else {
      text += line.translateToString(false);
    }
  }

  return extractTerminalCommand(text);
}


// Heuristic: does the terminal currently show an idle shell prompt waiting for
// input? The logical prompt must be non-empty AND end in a common
// prompt terminator with nothing typed after it. This deliberately returns
// false for a blank screen (shell still starting up — e.g. a slow .bashrc /
// conda init), a streaming MOTD, or a half-typed command, so callers that need
// to inject a hidden setup line wait for a clean, ready prompt instead of
// firing into a not-yet-ready shell (whose buffered echo would arrive late and
// leak past the echo suppressor). Covers bash/zsh ("$ "/"# "/"% "), root,
// PowerShell-over-SSH ("> "); fancy custom prompts won't match (callers then
// skip integration, which is safe).
export function terminalAtIdlePrompt(term: Terminal): boolean {
  const buffer = term.buffer.active;
  if (buffer.type === "alternate") return false;

  let cursorRow = buffer.baseY + buffer.cursorY;
  let readlineMargin = false;
  // Readline can explicitly move to a non-wrapped row at the right margin,
  // either after the prompt's final space or immediately before printing it.
  // Only join the immediately preceding full row while readline is active;
  // unused padded cells and older output must not establish readiness.
  const cursorLine = buffer.getLine(cursorRow);
  let beforeMarginSpace = false;
  if (
    buffer.cursorX <= 1 && cursorRow > 0 && term.modes.bracketedPasteMode
    && !cursorLine?.isWrapped
    && !cursorLine?.translateToString(true).trim()
  ) {
    const marginCell = buffer.getLine(cursorRow - 1)?.getCell(term.cols - 1)?.getChars();
    const afterMarginSpace = buffer.cursorX === 0 && marginCell === " ";
    beforeMarginSpace = buffer.cursorX === 1 && cursorLine?.getCell(0)?.getChars() === " "
      && marginCell !== undefined && /^[$#>%]$/.test(marginCell);
    if (afterMarginSpace || beforeMarginSpace) {
      cursorRow -= 1;
      readlineMargin = true;
    }
  }
  let start = cursorRow;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;

  let text = "";
  for (let row = start; row <= cursorRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    text +=
      row === cursorRow && !readlineMargin
        ? line.translateToString(false).slice(0, buffer.cursorX)
        : line.translateToString(false);
  }

  if (readlineMargin && beforeMarginSpace) text += " ";
  if (text.replace(/\s+$/, "").length === 0) return false; // blank: not ready
  if (readlineMargin && extractTerminalCommand(text) !== "") return false;
  // Ends in a prompt terminator, optionally followed by a single space.
  return /[$#>%][ \t]{0,4}$/.test(text);
}


export function computeInlineGhost(
  term: Terminal | null,
  panel: HTMLDivElement | null,
  container: HTMLDivElement | null,
  enabled: boolean,
  pending: string,
  suggestion: string | null,
  invalidated: boolean,
): { left: number; top: number; maxWidth: number; height: number; text: string } | null {
  if (!enabled || !term || !panel || !container) return null;
  if (invalidated || !pending || !suggestion) return null;
  if (!suggestion.startsWith(pending) || suggestion.length <= pending.length) return null;
  if (term.buffer.active.type === "alternate") return null;

  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;

  const screenRect = screen.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0 || term.cols === 0 || term.rows === 0) {
    return null;
  }

  // Only render when the cursor row is actually on screen (user hasn't scrolled away).
  const cursorX = term.buffer.active.cursorX;
  const cursorY = term.buffer.active.cursorY;
  if (cursorY < 0 || cursorY >= term.rows) return null;

  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const baseLeft = screenRect.left - panelRect.left;
  const baseTop = screenRect.top - panelRect.top;

  const left = baseLeft + cursorX * cellWidth;
  const top = baseTop + cursorY * cellHeight;
  const maxWidth = Math.max(0, (term.cols - cursorX) * cellWidth);
  if (maxWidth <= 0) return null;

  const text = suggestion.slice(pending.length);
  return { left, top, maxWidth, height: cellHeight, text };
}


export function getVisibleSearchHighlights(
  term: Terminal | null,
  panel: HTMLDivElement | null,
  container: HTMLDivElement | null,
  matches: SearchMatch[],
  activeIndex: number,
) {
  if (!term || !panel || !container || matches.length === 0) return [];

  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return [];

  const screenRect = screen.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0 || term.cols === 0 || term.rows === 0) {
    return [];
  }

  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const viewportTop = term.buffer.active.viewportY;
  const viewportBottom = viewportTop + term.rows - 1;
  const baseLeft = screenRect.left - panelRect.left;
  const baseTop = screenRect.top - panelRect.top;

  return matches
    .map((match, index) => ({ ...match, index }))
    .filter((match) => match.row >= viewportTop && match.row <= viewportBottom)
    .map((match) => ({
      row: match.row,
      col: match.col,
      active: match.index === activeIndex,
      left: baseLeft + match.col * cellWidth,
      top: baseTop + (match.row - viewportTop) * cellHeight,
      width: Math.max(cellWidth, match.length * cellWidth),
      height: cellHeight,
    }));
}


export function getVisibleTerminalBlockSelectionHighlights(
  term: Terminal | null,
  panel: HTMLDivElement | null,
  container: HTMLDivElement | null,
  selection: TerminalBlockSelection | null,
) {
  if (!term || !panel || !container || !selection) return [];

  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return [];

  const screenRect = screen.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0 || term.cols === 0 || term.rows === 0) {
    return [];
  }

  const range = normalizeTerminalBlockSelection(selection, term.cols);
  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const viewportTop = term.buffer.active.viewportY;
  const viewportBottom = viewportTop + term.rows - 1;
  const baseLeft = screenRect.left - panelRect.left;
  const baseTop = screenRect.top - panelRect.top;
  const startRow = Math.max(range.startRow, viewportTop);
  const endRow = Math.min(range.endRow, viewportBottom);
  const highlights: Array<{ row: number; left: number; top: number; width: number; height: number }> = [];

  for (let row = startRow; row <= endRow; row += 1) {
    highlights.push({
      row,
      left: baseLeft + range.startCol * cellWidth,
      top: baseTop + (row - viewportTop) * cellHeight,
      width: Math.max(cellWidth, (range.endCol - range.startCol) * cellWidth),
      height: cellHeight,
    });
  }

  return highlights;
}


export function getVisibleKeywordHighlights(
  term: Terminal | null,
  panel: HTMLDivElement | null,
  container: HTMLDivElement | null,
  mode: TerminalSyntaxMode,
) {
  if (mode !== "keywords" || !term || !panel || !container) return [];
  const matches = collectKeywordMatches(term);
  if (matches.length === 0) return [];

  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return [];

  const screenRect = screen.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0 || term.cols === 0 || term.rows === 0) {
    return [];
  }

  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const viewportTop = term.buffer.active.viewportY;
  const viewportBottom = viewportTop + term.rows - 1;
  const baseLeft = screenRect.left - panelRect.left;
  const baseTop = screenRect.top - panelRect.top;

  return matches
    .filter((match) => match.row >= viewportTop && match.row <= viewportBottom)
    .map((match) => ({
      ...match,
      left: baseLeft + match.col * cellWidth,
      top: baseTop + (match.row - viewportTop) * cellHeight,
      width: Math.max(cellWidth, match.length * cellWidth),
      height: cellHeight,
    }));
}


export function collectKeywordMatches(term: Terminal): KeywordHighlight[] {
  const rules: Array<{ kind: KeywordHighlight["kind"]; pattern: RegExp }> = [
    { kind: "error", pattern: /\b(error|fail(?:ed|ure)?|denied|panic|fatal)\b/gi },
    { kind: "warning", pattern: /\b(warn(?:ing)?|caution)\b/gi },
    { kind: "success", pattern: /\b(success|ok|done|passed)\b/gi },
  ];
  const buffer = term.buffer.active;
  const matches: KeywordHighlight[] = [];

  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;

    const { text, stringIndexToCell } = lineToSearchText(line);
    for (const rule of rules) {
      for (const match of text.matchAll(rule.pattern)) {
        if (typeof match.index !== "number" || !match[0]) continue;
        const startCell = stringIndexToCell[match.index];
        const lastCell = stringIndexToCell[match.index + match[0].length - 1];
        if (typeof startCell !== "number" || typeof lastCell !== "number") continue;
        const lastWidth = line.getCell(lastCell)?.getWidth() || 1;
        matches.push({
          row,
          col: startCell,
          length: Math.max(1, lastCell + lastWidth - startCell),
          kind: rule.kind,
        });
      }
    }
  }

  return matches;
}


export function firstVisibleMatchIndex(
  term: Terminal,
  matches: SearchMatch[],
  direction: "next" | "previous",
): number {
  const viewportTop = term.buffer.active.viewportY;
  const viewportBottom = viewportTop + term.rows - 1;

  if (direction === "next") {
    const visible = matches.findIndex((match) => match.row >= viewportTop);
    return visible === -1 ? 0 : visible;
  }

  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].row <= viewportBottom) return i;
  }
  return matches.length - 1;
}
