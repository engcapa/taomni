import { type DebugBreakpoint, type BreakpointSyncPlan, type DebugBreakpointMode, type BreakpointBinding, type BreakpointRuntimeState } from "./types";
import { resolveBreakpointMode } from "./functionInstructionBreakpoints";
import { asRecord, bindingRuntimeStatus } from "./shared";

/** True unless the breakpoint was explicitly disabled. */
export function isBreakpointEnabled(bp: DebugBreakpoint): boolean {
  return bp.enabled !== false;
}

/**
 * Normalize a source path to the OS-native form the debug adapter expects.
 * On Windows, java-debug matches breakpoint source paths against JDT's records,
 * which use a lowercase drive letter and backslashes — a forward-slash /
 * uppercase-drive path (our internal normalized form) leaves breakpoints
 * `verified: false` and they never bind. Detected by a `X:` drive prefix, so
 * POSIX absolute paths (`/…`) are returned unchanged.
 */
export function toAdapterSourcePath(path: string): string {
  if (!/^[A-Za-z]:/.test(path)) return path; // not a Windows drive path
  return path
    .replace(/^([A-Za-z]):/, (_m, drive) => `${drive.toLowerCase()}:`)
    .replace(/\//g, "\\");
}

/** Breakpoints in the exact order sent to the adapter (sorted by line). */
export function sortedBreakpoints(list: DebugBreakpoint[]): DebugBreakpoint[] {
  return list.slice().sort((a, b) => a.line - b.line);
}

/** True when the breakpoint stops the program (IDEA "Suspend"). */
export function effectiveSuspend(bp: DebugBreakpoint): boolean {
  return bp.suspend ?? !bp.logMessage?.trim();
}

/**
 * The logpoint text a non-suspending breakpoint hands to the adapter. Null
 * for suspending breakpoints and for ones with nothing to log.
 */
export function adapterLogMessage(bp: DebugBreakpoint, path: string): string | null {
  if (effectiveSuspend(bp)) return null;
  const parts: string[] = [];
  if (bp.logHitMessage) {
    const file = path.split(/[\\/]/).pop();
    parts.push(file ? `Breakpoint reached at ${file}:${bp.line}` : `Breakpoint reached at line ${bp.line}`);
  }
  if (bp.logExpression?.trim()) parts.push(`{${bp.logExpression.trim()}}`);
  if (bp.logMessage?.trim()) parts.push(bp.logMessage.trim());
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Decide which of a file's breakpoints go to the adapter.
 * `muted` suppresses all of them (IDEA "Mute Breakpoints"); `extraLine` adds a
 * transient run-to-cursor breakpoint that is never stored. `isArmed` keeps a
 * dependent breakpoint back until its master is hit, and `clientManaged`
 * marks breakpoints whose hit the client must observe (the adapter then
 * suspends and the client resumes after running the actions).
 */
export function planBreakpointSync(
  list: DebugBreakpoint[],
  options: {
    muted?: boolean;
    extraLine?: number;
    path?: string;
    isArmed?: (bp: DebugBreakpoint) => boolean;
    clientManaged?: (bp: DebugBreakpoint) => boolean;
  } = {},
): BreakpointSyncPlan {
  const sorted = sortedBreakpoints(list);
  const sent: DebugBreakpoint[] = [];
  const indexes: number[] = [];
  const logMessages: (string | null)[] = [];
  if (!options.muted) {
    sorted.forEach((bp, index) => {
      if (!isBreakpointEnabled(bp)) return;
      if (options.isArmed && !options.isArmed(bp)) return;
      const managed = options.clientManaged?.(bp) ?? false;
      const log = managed ? null : adapterLogMessage(bp, options.path ?? "");
      // A non-suspending breakpoint with nothing to log and nothing for the
      // client to do would only slow the debuggee down.
      if (!managed && !effectiveSuspend(bp) && log == null) return;
      sent.push(bp);
      indexes.push(index);
      logMessages.push(log);
    });
  }
  const extra = options.extraLine;
  if (extra != null && !sent.some((bp) => bp.line === extra)) {
    // Keep the request sorted by line, as the response corresponds positionally.
    const at = sent.findIndex((bp) => bp.line > extra);
    const insertAt = at === -1 ? sent.length : at;
    sent.splice(insertAt, 0, { line: extra });
    indexes.splice(insertAt, 0, -1);
    logMessages.splice(insertAt, 0, null);
  }
  return { sorted, sent, indexes, logMessages };
}

/**
 * Build DAP `setBreakpoints` arguments for one source file from a sync plan.
 * The response's `breakpoints` array corresponds 1:1, in order, to `plan.sent`
 * (see parseSetBreakpointsResponse).
 */
export function buildSetBreakpointsArgs(
  path: string,
  plan: BreakpointSyncPlan,
  options: {
    adapterId?: string;
    breakpointModes?: readonly DebugBreakpointMode[];
  } = {},
) {
  return {
    source: { path, name: path.split(/[\\/]/).pop() ?? path },
    breakpoints: plan.sent.map((bp, index) => {
      const entry: Record<string, unknown> = { line: bp.line };
      if (bp.condition && bp.condition.trim()) entry.condition = bp.condition.trim();
      if (bp.hitCondition && bp.hitCondition.trim()) entry.hitCondition = bp.hitCondition.trim();
      const logMessage = plan.logMessages ? plan.logMessages[index] : bp.logMessage?.trim();
      if (logMessage) entry.logMessage = logMessage;
      const mode = resolveBreakpointMode(
        options.adapterId ? bp.adapterModes?.[options.adapterId] : undefined,
        options.breakpointModes ?? [],
        "source",
      );
      if (mode) entry.mode = mode;
      return entry;
    }),
    // Ask the adapter to re-verify from source lines.
    sourceModified: false,
  };
}

/**
 * Parse a `setBreakpoints` response. Per the DAP spec the response array
 * corresponds 1:1, in order, to the requested breakpoints — so it is indexed
 * against `plan.sent`.
 */
export function parseSetBreakpointsResponse(
  plan: BreakpointSyncPlan,
  body: unknown,
): BreakpointBinding[] {
  const reported = asRecord(body).breakpoints;
  const list = Array.isArray(reported) ? reported : [];
  return plan.sent.map((bp, i) => {
    const rec = asRecord(list[i]);
    return {
      id: typeof rec.id === "number" ? rec.id : null,
      verified: rec.verified === true,
      line: typeof rec.line === "number" && rec.line > 0 ? rec.line : bp.line,
      message: typeof rec.message === "string" && rec.message ? rec.message : null,
      reason: rec.reason === "pending" || rec.reason === "failed" ? rec.reason : null,
    };
  });
}

/**
 * Adopt adapter-adjusted lines: a breakpoint on a non-executable line gets
 * moved to the line the adapter actually bound (IDEA/VS Code behavior). Only
 * verified bindings move a breakpoint; entries collapsing onto an already-used
 * line are dropped. Breakpoints the plan did not send (disabled / muted) are
 * carried through untouched.
 */
export function reconcileBreakpointLines(
  plan: BreakpointSyncPlan,
  bindings: BreakpointBinding[],
): DebugBreakpoint[] {
  const boundLines = new Map<number, number>(); // index in `sorted` → bound line
  plan.indexes.forEach((index, k) => {
    const binding = bindings[k];
    if (index >= 0 && binding && binding.verified) boundLines.set(index, binding.line);
  });
  const out: DebugBreakpoint[] = [];
  const seen = new Set<number>();
  plan.sorted.forEach((bp, index) => {
    const line = boundLines.get(index) ?? bp.line;
    if (seen.has(line)) return;
    seen.add(line);
    out.push(line === bp.line ? bp : { ...bp, line });
  });
  return out;
}

/**
 * Verification state per bound line, for the gutter. Only sent breakpoints have
 * one — a disabled or muted breakpoint is rendered from its stored state.
 */
export function breakpointVerificationMap(
  plan: BreakpointSyncPlan,
  bindings: BreakpointBinding[],
): Record<number, BreakpointRuntimeState> {
  const out: Record<number, BreakpointRuntimeState> = {};
  plan.sent.forEach((bp, k) => {
    const binding = bindings[k];
    const line = binding?.line ?? bp.line;
    out[line] = binding
      ? bindingRuntimeStatus(binding)
      // No binding element at all (short/missing response) → not yet confirmed.
      : { status: "pending", message: null };
  });
  return out;
}

/** Parse a `breakpoint` event (adapters re-verify bindings as classes load). */
export function parseBreakpointEvent(
  message: unknown,
): {
  reason: string;
  id: number | null;
  verified: boolean;
  line: number | null;
  /** Adapter explanation for an unverified breakpoint, when provided. */
  message: string | null;
  /** DAP breakpoint `reason` field (distinct from the event's `reason`). */
  bindReason: "pending" | "failed" | null;
} | null {
  const body = asRecord(asRecord(message).body);
  const bp = asRecord(body.breakpoint);
  if (Object.keys(bp).length === 0) return null;
  return {
    reason: typeof body.reason === "string" ? body.reason : "changed",
    id: typeof bp.id === "number" ? bp.id : null,
    verified: bp.verified === true,
    line: typeof bp.line === "number" ? bp.line : null,
    message: typeof bp.message === "string" && bp.message ? bp.message : null,
    bindReason: bp.reason === "pending" || bp.reason === "failed" ? bp.reason : null,
  };
}
