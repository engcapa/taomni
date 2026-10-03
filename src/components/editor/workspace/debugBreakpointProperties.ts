/**
 * IDEA breakpoint properties that DAP has no field for (Remove once hit,
 * dependent breakpoints, stack-trace logging, non-suspending hits) plus the
 * IDEA-style labels the debugger views print. Pure so the semantics unit-test
 * without an adapter; useCodeDebugSession applies the resulting actions.
 */
import {
  effectiveSuspend,
  isBreakpointEnabled,
  type DebugBreakpoint,
  type DebugStackFrame,
  type DebugThread,
} from "./dapDebugModel";

export type BreakpointMapLike = Record<string, DebugBreakpoint[]>;

export interface BreakpointRef {
  path: string;
  line: number;
}

/** Stable identity of one stored line breakpoint. */
export function breakpointRefKey(path: string, line: number): string {
  return `${path}\u0000${line}`;
}

/** `App.java:12` — IDEA's breakpoint display text. */
export function breakpointDisplayName(path: string, line: number): string {
  return `${path.split(/[\\/]/).pop() ?? path}:${line}`;
}

function findBreakpoint(map: BreakpointMapLike, ref: BreakpointRef): DebugBreakpoint | undefined {
  return map[ref.path]?.find((bp) => bp.line === ref.line);
}

/** The master a dependent waits for, or null when the dependency dangles. */
export function masterOf(bp: DebugBreakpoint, map: BreakpointMapLike): BreakpointRef | null {
  const ref = bp.dependsOn;
  if (!ref) return null;
  return findBreakpoint(map, ref) ? ref : null;
}

/** Keys of every breakpoint some existing dependent waits for. */
export function breakpointMasterKeys(map: BreakpointMapLike): Set<string> {
  const keys = new Set<string>();
  for (const list of Object.values(map)) {
    for (const bp of list) {
      const master = masterOf(bp, map);
      if (master) keys.add(breakpointRefKey(master.path, master.line));
    }
  }
  return keys;
}

/** Breakpoints that wait for `master`. */
export function dependentsOf(master: BreakpointRef, map: BreakpointMapLike): BreakpointRef[] {
  const out: BreakpointRef[] = [];
  for (const [path, list] of Object.entries(map)) {
    for (const bp of list) {
      if (bp.dependsOn && bp.dependsOn.path === master.path && bp.dependsOn.line === master.line) {
        out.push({ path, line: bp.line });
      }
    }
  }
  return out;
}

/**
 * Whether the client must see this breakpoint's hits. DAP logpoints can only
 * print interpolated text, so stack traces, Remove once hit, dependents and
 * logging on a suspending breakpoint are run by the client.
 */
export function needsClientHit(bp: DebugBreakpoint, isMaster: boolean): boolean {
  if (bp.temporary || isMaster || bp.logStack) return true;
  if (bp.dependsOn && !bp.leaveEnabled) return true;
  return effectiveSuspend(bp)
    && (!!bp.logHitMessage || !!bp.logExpression?.trim() || !!bp.logMessage?.trim());
}

/** True when some enabled breakpoint needs a pass-through (auto-resumed) hit. */
export function hasClientNonSuspending(map: BreakpointMapLike): boolean {
  const masters = breakpointMasterKeys(map);
  return Object.entries(map).some(([path, list]) => list.some((bp) => (
    isBreakpointEnabled(bp)
    && !effectiveSuspend(bp)
    && needsClientHit(bp, masters.has(breakpointRefKey(path, bp.line)))
  )));
}

/** IDEA's gutter tooltip for a line breakpoint (one entry per line). */
export function breakpointTooltipLines(
  bp: DebugBreakpoint,
  path: string,
  options: { muted?: boolean; map?: BreakpointMapLike } = {},
): string[] {
  const lines = [`Line breakpoint: ${breakpointDisplayName(path, bp.line)}`];
  if (!isBreakpointEnabled(bp)) lines.push("Disabled");
  if (options.muted) lines.push("Muted");
  lines.push(effectiveSuspend(bp) ? "Suspend: all" : "Suspend: none");
  if (bp.condition?.trim()) lines.push(`Condition: ${bp.condition.trim()}`);
  if (bp.hitCondition?.trim()) lines.push(`Pass count: ${bp.hitCondition.trim()}`);
  if (bp.logHitMessage) lines.push("Log message: yes");
  if (bp.logStack) lines.push("Log stack: yes");
  if (bp.logExpression?.trim()) lines.push(`Log expression: ${bp.logExpression.trim()}`);
  if (bp.logMessage?.trim()) lines.push(`Log template: ${bp.logMessage.trim()}`);
  if (bp.temporary) lines.push("Remove once hit");
  const master = options.map ? masterOf(bp, options.map) : bp.dependsOn ?? null;
  if (master) lines.push(`Depends on: ${breakpointDisplayName(master.path, master.line)}`);
  return lines;
}

export interface FrameLabel {
  method: string;
  line: number;
  className: string | null;
  pkg: string | null;
}

/**
 * Split an adapter frame name (`com.acme.App.main(String[])`, `App.main`) into
 * IDEA's `method:line, Class (package)` parts. Names that are not
 * `Type.method` (native, JS, …) keep their text as the method.
 */
export function frameLabel(frame: DebugStackFrame): FrameLabel {
  const withoutArgs = frame.name.replace(/\(.*\)\s*$/, "").trim();
  const match = /^(?:(.*)\.)?([^.\s]+)\.([^.\s]+)$/.exec(withoutArgs);
  if (!match) return { method: frame.name, line: frame.line, className: null, pkg: null };
  const [, qualifier, className, method] = match;
  return {
    method,
    line: frame.line,
    className,
    pkg: qualifier ?? packageFromPath(frame.path),
  };
}

/** `main:12, App (com.acme)` as IDEA prints a stack frame. */
export function frameLabelText(frame: DebugStackFrame): string {
  const label = frameLabel(frame);
  const head = label.line > 0 ? `${label.method}:${label.line}` : label.method;
  if (!label.className) return head;
  return label.pkg ? `${head}, ${label.className} (${label.pkg})` : `${head}, ${label.className}`;
}

/** Java-style package from a source path under a conventional source root. */
export function packageFromPath(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  const marker = /\/src\/(?:main|test)\/(?:java|kotlin|scala|groovy)\/(.+)\/[^/]+$/.exec(normalized);
  return marker ? marker[1].replace(/\//g, ".") : null;
}

/**
 * IDEA greys (and optionally folds) frames that are not project code: frames
 * without a readable source file or ones the adapter de-emphasizes.
 */
export function isLibraryFrame(frame: DebugStackFrame): boolean {
  if (frame.presentationHint === "subtle" || frame.presentationHint === "deemphasize") return true;
  return !frame.path;
}

export type FrameListEntry =
  | { kind: "frame"; frame: DebugStackFrame; library: boolean }
  | { kind: "folded"; count: number; firstId: number };

/** Frames as the list shows them; consecutive hidden library frames fold. */
export function frameListEntries(frames: DebugStackFrame[], hideLibrary: boolean): FrameListEntry[] {
  const out: FrameListEntry[] = [];
  frames.forEach((frame, index) => {
    const library = isLibraryFrame(frame);
    // The top frame is where execution is: IDEA never folds it away.
    if (!hideLibrary || !library || index === 0) {
      out.push({ kind: "frame", frame, library });
      return;
    }
    const last = out[out.length - 1];
    if (last?.kind === "folded") last.count += 1;
    else out.push({ kind: "folded", count: 1, firstId: frame.id });
  });
  return out;
}

/** `"main"@1: RUNNING` — IDEA's thread combo text (without thread groups). */
export function threadLabelText(thread: DebugThread, suspended: boolean): string {
  const bare = /^Thread \[(.*)\]$/.exec(thread.name)?.[1] ?? thread.name;
  return `"${bare}"@${thread.id}: ${suspended ? "SUSPENDED" : "RUNNING"}`;
}

/** Wrap an adapter object id (`ArrayList@12 size=3`) in IDEA's braces. */
export function variableValueText(value: string): string {
  const match = /^([A-Za-z_$][\w$.<>,[\]]*@[0-9a-fA-Fx]+)(.*)$/.exec(value);
  if (!match || value.startsWith("{")) return value;
  const rest = match[2].trim();
  return rest ? `{${match[1]}} ${rest}` : `{${match[1]}}`;
}

/** Segments of a `{expr}` log template: literal text and expressions. */
export function logTemplateParts(template: string): Array<{ text: string } | { expression: string }> {
  const parts: Array<{ text: string } | { expression: string }> = [];
  const re = /\{([^{}]+)\}/g;
  let last = 0;
  for (const match of template.matchAll(re)) {
    if (match.index > last) parts.push({ text: template.slice(last, match.index) });
    parts.push({ expression: match[1].trim() });
    last = match.index + match[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return parts;
}

/** A frame as a Java stack-trace line: `App.main(App.java:12)`. */
export function stackLineText(frame: DebugStackFrame): string {
  const name = frame.name.replace(/\(.*\)\s*$/, "").trim() || frame.name;
  const file = frame.path?.split(/[\\/]/).pop() ?? frame.sourceName;
  return file ? `${name}(${file}:${frame.line})` : name;
}

/**
 * Console text IDEA prints for a hit: `Breakpoint reached at …` for the hit
 * message, `Breakpoint reached` plus `\tat` lines for the stack trace, and
 * the evaluated expression/template values.
 */
export function breakpointHitLogText(
  bp: DebugBreakpoint,
  frames: DebugStackFrame[],
  values: { expression?: string | null; template?: string | null } = {},
): string {
  const lines: string[] = [];
  const top = frames[0];
  if (bp.logStack) {
    lines.push("Breakpoint reached");
    for (const frame of frames) lines.push(`\tat ${stackLineText(frame)}`);
  } else if (bp.logHitMessage) {
    lines.push(top ? `Breakpoint reached at ${stackLineText(top)}` : "Breakpoint reached");
  }
  if (values.expression != null) lines.push(values.expression);
  if (values.template != null) lines.push(values.template);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
