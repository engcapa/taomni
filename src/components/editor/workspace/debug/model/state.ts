import {
  type DebugWatchItem,
  type DebugSessionState,
  type DebugConsoleLine,
  type DebugStepAction,
  type DebugThread,
  type DebugStackFrame,
  type DebugExceptionInfo,
  type EvaluateResult,
} from "./types";
import { asRecord } from "./shared";

export function migrateWatchItems(raw: unknown): DebugWatchItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    if (typeof item === "string") {
      return {
        id: `watch-${index}-${Date.now().toString(36)}`,
        expression: item,
        enabled: true,
        order: index,
        lastError: null,
      };
    }
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      return {
        id: typeof rec.id === "string" && rec.id ? rec.id : `watch-${index}-${Date.now().toString(36)}`,
        expression: typeof rec.expression === "string" ? rec.expression : "",
        enabled: typeof rec.enabled === "boolean" ? rec.enabled : true,
        order: typeof rec.order === "number" ? rec.order : index,
        lastError: typeof rec.lastError === "string" ? rec.lastError : null,
      };
    }
    return {
      id: `watch-${index}-${Date.now().toString(36)}`,
      expression: String(item),
      enabled: true,
      order: index,
      lastError: null,
    };
  }).filter((item) => item.expression.trim().length > 0);
}

export function initialDebugState(sessionId: string): DebugSessionState {
  return {
    sessionId,
    status: "starting",
    stopEpoch: 0,
    stoppedThreadId: null,
    stoppedReason: null,
    threads: [],
    frames: [],
    selectedThreadId: null,
    selectedFrameId: null,
    exceptionInfo: null,
    output: [],
  };
}

/**
 * State transition when the debuggee resumes. Also applied optimistically after
 * a successful continue/step response: adapters are not required to emit a
 * `continued` event for explicit resumes, so waiting for one leaves the UI
 * frozen on a stale stack.
 */
export function markResumed(state: DebugSessionState): DebugSessionState {
  return {
    ...state,
    status: "running",
    stoppedThreadId: null,
    stoppedReason: null,
    frames: [],
    selectedThreadId: null,
    selectedFrameId: null,
    exceptionInfo: null,
  };
}

/** Cap retained console lines and memory budget (10,000 lines and 2 MiB). */
export const MAX_CONSOLE_LINES = 10000;

export const MAX_CONSOLE_BYTES = 2 * 1024 * 1024;
// 2 MiB

/** Append a console line (no-op for empty text), with 10k lines + 2 MiB dual-budget eviction. */
export function appendConsoleLine(
  state: DebugSessionState,
  category: string,
  text: string,
  seq?: number,
  timestamp?: number,
): DebugSessionState {
  if (!text) return state;
  const newLine: DebugConsoleLine = {
    category,
    text,
    ...(seq !== undefined ? { seq } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
  let lines = [...state.output, newLine];
  if (lines.length > MAX_CONSOLE_LINES) {
    lines = lines.slice(-MAX_CONSOLE_LINES);
  }

  // D7.4: 2 MiB dual byte budget eviction
  let totalBytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    totalBytes += lines[i]!.text.length;
    if (totalBytes > MAX_CONSOLE_BYTES) {
      lines = lines.slice(i + 1);
      break;
    }
  }

  return { ...state, output: lines };
}

export function stepCommandFor(action: DebugStepAction): string {
  switch (action) {
    case "continue": return "continue";
    case "pause": return "pause";
    case "stepOver": return "next";
    case "stepIn": return "stepIn";
    case "stepOut": return "stepOut";
    case "stepBack": return "stepBack";
    case "reverseContinue": return "reverseContinue";
  }
}

/** Parse a `threads` response body into our thread list. */
export function parseThreads(body: unknown): DebugThread[] {
  const threads = asRecord(body).threads;
  if (!Array.isArray(threads)) return [];
  return threads.flatMap((t) => {
    const rec = asRecord(t);
    return typeof rec.id === "number"
      ? [{ id: rec.id, name: typeof rec.name === "string" ? rec.name : `Thread ${rec.id}` }]
      : [];
  });
}

/** Parse a `stackTrace` response body into frames (source path + line). */
export function parseStackFrames(body: unknown): DebugStackFrame[] {
  const frames = asRecord(body).stackFrames;
  if (!Array.isArray(frames)) return [];
  return frames.flatMap((f) => {
    const rec = asRecord(f);
    if (typeof rec.id !== "number") return [];
    const source = asRecord(rec.source);
    return [{
      id: rec.id,
      name: typeof rec.name === "string" ? rec.name : `frame ${rec.id}`,
      path: typeof source.path === "string" && source.path ? source.path : null,
      line: typeof rec.line === "number" ? rec.line : 0,
      column: typeof rec.column === "number" ? rec.column : 0,
      sourceReference: typeof source.sourceReference === "number" ? source.sourceReference : 0,
      sourceName: typeof source.name === "string" && source.name ? source.name : null,
      presentationHint: typeof rec.presentationHint === "string"
        ? rec.presentationHint
        : typeof source.presentationHint === "string" ? source.presentationHint : null,
    }];
  });
}

/** `totalFrames` from a `stackTrace` response, when the adapter reports it. */
export function parseStackTotal(body: unknown): number | null {
  const total = asRecord(body).totalFrames;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null;
}

/** Parse an `exceptionInfo` response body (null when the adapter has nothing). */
export function parseExceptionInfo(body: unknown): DebugExceptionInfo | null {
  const rec = asRecord(body);
  const exceptionId = typeof rec.exceptionId === "string" ? rec.exceptionId : "";
  const description = typeof rec.description === "string" ? rec.description : "";
  if (!exceptionId && !description) return null;
  const details = asRecord(rec.details);
  return {
    exceptionId: exceptionId || "Exception",
    description,
    details: typeof details.stackTrace === "string" ? details.stackTrace : null,
  };
}

/** Parse an `evaluate` response body into display value + expandable ref. */
export function parseEvaluate(body: unknown): EvaluateResult {
  const rec = asRecord(body);
  return {
    value: typeof rec.result === "string" ? rec.result : "",
    variablesReference: typeof rec.variablesReference === "number" ? rec.variablesReference : 0,
    type: typeof rec.type === "string" ? rec.type : null,
  };
}

/**
 * The source location to highlight as "current" — the selected frame when set,
 * else the top frame that has a path.
 */
export function currentLocation(
  frames: DebugStackFrame[],
  selectedFrameId?: number | null,
): { path: string; line: number; } | null {
  if (selectedFrameId != null) {
    const selected = frames.find((f) => f.id === selectedFrameId);
    if (selected?.path) return { path: selected.path, line: selected.line };
  }
  const frame = frames.find((f) => f.path);
  return frame && frame.path ? { path: frame.path, line: frame.line } : null;
}

/** Reduce an adapter event into new session state (pure). `output` accumulates. */
export function reduceDebugEvent(
  state: DebugSessionState,
  event: string,
  message: unknown,
): DebugSessionState {
  const body = asRecord(asRecord(message).body);
  switch (event) {
    case "stopped": {
      const threadId = typeof body.threadId === "number" ? body.threadId : state.stoppedThreadId;
      return {
        ...state,
        status: "stopped",
        stopEpoch: (state.stopEpoch ?? 0) + 1,
        stoppedThreadId: threadId,
        selectedThreadId: threadId,
        stoppedReason: typeof body.reason === "string" ? body.reason : "stopped",
        allThreadsStopped: body.allThreadsStopped === true,
        exceptionInfo: null,
      };
    }
    case "continued":
      return markResumed(state);
    case "exited": {
      const next: DebugSessionState = {
        ...state,
        status: "terminated",
        stoppedThreadId: null,
        stoppedReason: null,
        selectedThreadId: null,
        selectedFrameId: null,
        // The debuggee is gone: its threads and frames no longer describe
        // anything inspectable, so the panel must not keep showing a stack.
        threads: [],
        frames: [],
        exceptionInfo: null,
      };
      // IDEA-style closing line with the process exit code.
      return typeof body.exitCode === "number"
        ? appendConsoleLine(next, "console", `\nProcess finished with exit code ${body.exitCode}\n`)
        : next;
    }
    case "terminated":
      return {
        ...state,
        status: "terminated",
        stoppedThreadId: null,
        stoppedReason: null,
        selectedThreadId: null,
        selectedFrameId: null,
        threads: [],
        frames: [],
        exceptionInfo: null,
      };
    case "output": {
      const text = typeof body.output === "string" ? body.output : "";
      const category = typeof body.category === "string" && body.category ? body.category : "stdout";
      if (!text || category === "telemetry") return state;
      return appendConsoleLine(state, category, text);
    }
    case "thread": {
      // Keep the thread list live while running — adapters report starts/exits
      // as they happen, and a `threads` request is only allowed while stopped.
      const threadId = typeof body.threadId === "number" ? body.threadId : null;
      if (threadId == null) return state;
      if (body.reason === "exited") {
        return { ...state, threads: state.threads.filter((t) => t.id !== threadId) };
      }
      if (state.threads.some((t) => t.id === threadId)) return state;
      return { ...state, threads: [...state.threads, { id: threadId, name: `Thread ${threadId}` }] };
    }
    default:
      return state;
  }
}

/**
 * The expression under `pos` in a line of source, for hover evaluation: a
 * dotted identifier chain (`order.items.size`) plus any trailing `[i]` index,
 * which is what IDEA evaluates when you hover a variable. Returns null when the
 * position is not on an identifier. Pure — deliberately syntax-free so it works
 * for every language the DAP framework serves.
 */
export function hoverExpressionAt(lineText: string, pos: number): string | null {
  if (pos < 0 || pos > lineText.length) return null;
  const isWord = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
  // The character under the caret, or the one just before it at a boundary.
  let end = pos;
  if (end < lineText.length && isWord(lineText[end])) {
    while (end < lineText.length && isWord(lineText[end])) end += 1;
  } else if (pos > 0 && isWord(lineText[pos - 1])) {
    end = pos;
  } else {
    return null;
  }
  let start = end;
  while (start > 0 && (isWord(lineText[start - 1]) || lineText[start - 1] === ".")) start -= 1;
  // A leading dot or a numeric literal is not something worth evaluating.
  const expression = lineText.slice(start, end).replace(/^\.+/, "");
  if (!expression || /^[0-9]/.test(expression)) return null;
  // Include a simple array/list index directly after the identifier.
  const rest = lineText.slice(end);
  const index = /^\[[^[\]]*\]/.exec(rest);
  return index ? `${expression}${index[0]}` : expression;
}

/**
 * Inline value label for one source line (IDEA shows evaluated locals next to
 * the code). Returns `name: value` pairs for every known variable mentioned on
 * the line, in order of appearance, or null when none are.
 */
export function inlineValueLabel(
  lineText: string,
  variables: Record<string, string>,
): string | null {
  const names = Object.keys(variables);
  if (names.length === 0) return null;
  const seen = new Set<string>();
  const parts: string[] = [];
  // Scan identifiers left to right so the label reads in source order. Skip
  // anything after a line comment and inside string literals is out of scope
  // for a syntax-free scan — a stale extra pair is harmless, a missing one is not.
  const code = lineText.split("//")[0];
  for (const match of code.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const name = match[0];
    // A member access (`obj.field`) is not the local `field`.
    if (match.index > 0 && code[match.index - 1] === ".") continue;
    if (seen.has(name) || !(name in variables)) continue;
    seen.add(name);
    // IDEA renders inline values as `name: value`.
    parts.push(`${name}: ${variables[name]}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}
