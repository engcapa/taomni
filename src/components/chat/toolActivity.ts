/**
 * Parse the compact tool-activity transcript that agent bridges (Claude Code,
 * ACP / Grok CLI, native tool loop) embed into assistant message content:
 *
 *   > 🔧 `run_in_terminal` — ls -la
 *   > ↳ total 12 …
 *
 * The lines are human-readable only (not `[TOOL_CALL]` markers) and would
 * otherwise render as a long blockquote chain. We lift them into structured
 * segments so the chat UI can collapse the run by default.
 */

export interface ToolActivityEntry {
  tool: string;
  detail?: string;
  result?: string;
}

export type ToolActivitySegment =
  | { kind: "text"; value: string }
  | { kind: "tools"; tools: ToolActivityEntry[] };

/** A tool-use line written by `format_cc_tool_use` in the Rust chat layer. */
const TOOL_USE_RE = /^\s*>\s*🔧\s*`([^`]+)`(?:\s*[—–-]\s*(.*))?\s*$/;
/** A tool-result preview line written next to a tool-use. */
const TOOL_RESULT_RE = /^\s*>\s*↳\s*(.*)\s*$/;

export function isToolActivityLine(line: string): boolean {
  return TOOL_USE_RE.test(line) || TOOL_RESULT_RE.test(line);
}

/**
 * Split source text into alternating prose and tool-activity runs. Contiguous
 * tool lines (and blank lines between them) form a single `tools` segment so
 * the UI can collapse an entire call sequence with one click.
 */
export function splitToolActivitySegments(source: string): ToolActivitySegment[] {
  if (!source) return [];

  const lines = source.split("\n");
  const segments: ToolActivitySegment[] = [];
  let textBuf: string[] = [];
  let toolBuf: ToolActivityEntry[] = [];
  /** Trailing blank lines held while deciding if a tool run continues. */
  let blankRun = 0;

  const flushText = () => {
    if (textBuf.length === 0) return;
    segments.push({ kind: "text", value: textBuf.join("\n") });
    textBuf = [];
  };

  const flushTools = () => {
    if (toolBuf.length === 0) return;
    segments.push({ kind: "tools", tools: toolBuf });
    toolBuf = [];
  };

  const appendBlanksToText = () => {
    for (let i = 0; i < blankRun; i++) textBuf.push("");
    blankRun = 0;
  };

  const appendBlanksIgnored = () => {
    // Blank lines inside a tool run are separators only — drop them.
    blankRun = 0;
  };

  for (const line of lines) {
    if (line.trim() === "") {
      blankRun += 1;
      continue;
    }

    const useMatch = line.match(TOOL_USE_RE);
    if (useMatch) {
      if (toolBuf.length === 0) {
        // Starting a new tool run — keep blanks with the preceding prose.
        appendBlanksToText();
        flushText();
      } else {
        appendBlanksIgnored();
      }
      const detail = (useMatch[2] ?? "").trim();
      toolBuf.push({
        tool: useMatch[1].trim(),
        detail: detail || undefined,
      });
      continue;
    }

    const resultMatch = line.match(TOOL_RESULT_RE);
    if (resultMatch) {
      if (toolBuf.length === 0) {
        // Orphan result with no preceding tool-use — treat as prose so we
        // don't invent a phantom card.
        appendBlanksToText();
        textBuf.push(line);
        continue;
      }
      appendBlanksIgnored();
      const result = (resultMatch[1] ?? "").trim();
      const last = toolBuf[toolBuf.length - 1];
      if (last.result === undefined) {
        last.result = result || undefined;
      } else {
        // Extra result lines after a completed tool — attach as a new entry
        // only if we somehow got a second ↳ without a tool use; otherwise
        // keep it with the last tool.
        last.result = `${last.result} ${result}`.trim();
      }
      continue;
    }

    // Ordinary prose: close any open tool run first.
    if (toolBuf.length > 0) {
      const blanksAfterTools = blankRun;
      blankRun = 0;
      flushTools();
      // Preserve at most one blank so layout stays tight between tools + text.
      if (blanksAfterTools > 0) {
        textBuf.push("");
      }
    } else {
      appendBlanksToText();
    }
    textBuf.push(line);
  }

  if (toolBuf.length > 0) {
    appendBlanksIgnored();
    flushTools();
    // Trailing blanks after a tool run are dropped.
  } else {
    appendBlanksToText();
    flushText();
  }

  // Drop empty text segments that can appear at edges.
  return segments.filter((s) => s.kind === "tools" || s.value.length > 0);
}

/** True when every tool entry already has a result (or the list is empty). */
export function allToolsSettled(tools: ToolActivityEntry[]): boolean {
  return tools.length > 0 && tools.every((t) => t.result !== undefined);
}
