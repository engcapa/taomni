/**
 * Pure debug-session model (M9). Argument builders, response parsers, and event
 * reducers for the DAP flow — all side-effect-free so they unit-test without a
 * live adapter. The orchestration hook (useCodeDebugSession) wires these to the
 * kernel commands + events. Everything here is DAP-standard and language-agnostic;
 * language-specific behavior stays in the Rust adapters.
 */

/** A user breakpoint on a source line (1-based), with optional D5 extras. */
export interface DebugBreakpoint {
  line: number;
  /** D5: only break when this expression is true. */
  condition?: string;
  /** Break only when the hit count matches (DAP `hitCondition`, e.g. "5"). */
  hitCondition?: string;
  /** D5: logpoint — log this message (with `{expr}` interpolation) instead of breaking. */
  logMessage?: string;
  /**
   * IDEA-style disable: the breakpoint stays in the list and the gutter but is
   * not sent to the adapter. `undefined` means enabled (breakpoints persisted
   * before this field existed stay armed).
   */
  enabled?: boolean;
  /** Adapter-specific source-breakpoint mode ids (for example hardware/software). */
  adapterModes?: Record<string, string>;
  /**
   * IDEA "Suspend". False makes a non-suspending breakpoint that only logs or
   * triggers dependents. Undefined keeps the pre-existing meaning: a stored
   * `logMessage` is a logpoint, anything else suspends.
   */
  suspend?: boolean;
  /** IDEA Log: "Breakpoint hit" message. */
  logHitMessage?: boolean;
  /** IDEA Log: Stack trace. */
  logStack?: boolean;
  /** IDEA Log: Evaluate and log — the expression whose value is printed. */
  logExpression?: string;
  /** IDEA "Remove once hit" (temporary breakpoint). */
  temporary?: boolean;
  /** IDEA "Disable until hitting the following breakpoint". */
  dependsOn?: { path: string; line: number; };
  /** IDEA "After hit": true = Leave enabled, otherwise Disable again. */
  leaveEnabled?: boolean;
}

/** A DAP function/method breakpoint, independent of any source path. */
export interface DebugFunctionBreakpoint {
  name: string;
  condition?: string;
  hitCondition?: string;
  /** Undefined means enabled, matching source-breakpoint persistence. */
  enabled?: boolean;
}

/** A DAP instruction breakpoint scoped to the adapter that owns the reference. */
export interface DebugInstructionBreakpoint {
  adapterId: string;
  /** Opaque instruction/memory reference supplied by the adapter or user. */
  instructionReference: string;
  /** Signed byte offset from `instructionReference`. */
  offset?: number;
  condition?: string;
  hitCondition?: string;
  /** Adapter-advertised instruction breakpoint mode. */
  mode?: string;
  /** Undefined means enabled, matching every other persisted breakpoint type. */
  enabled?: boolean;
}

export type DebugDataBreakpointAccessType = "read" | "write" | "readWrite";

export type DebugBreakpointModeApplicability =
  | "source"
  | "exception"
  | "data"
  | "instruction"
  | (string & {});

/** One breakpoint mode advertised by the adapter's initialize response. */
export interface DebugBreakpointMode {
  mode: string;
  label: string;
  description?: string;
  appliesTo: DebugBreakpointModeApplicability[];
}

/**
 * A DAP data breakpoint/watchpoint. Persistent data ids are scoped to one
 * adapter; non-persistent ids are scoped to the suspended session that issued
 * `dataBreakpointInfo` and are never written to workspace storage.
 */
export interface DebugDataBreakpoint {
  dataId: string;
  description: string;
  adapterId: string;
  accessTypes: DebugDataBreakpointAccessType[];
  accessType?: DebugDataBreakpointAccessType;
  condition?: string;
  hitCondition?: string;
  /** Number of bytes covered by the data id when the adapter supports ranges. */
  bytes?: number;
  /** Whether the discovery name was interpreted as a decimal/hex address. */
  asAddress?: boolean;
  /** Mode used when resolving this adapter-owned data id. */
  mode?: string;
  enabled?: boolean;
  canPersist: boolean;
  sessionId?: string;
}

export interface DebugDataBreakpointTarget {
  name: string;
  variablesReference?: number;
  frameId?: number;
  /** Optional range size, sent only with supportsDataBreakpointBytes. */
  bytes?: number;
  /** Interpret name as a decimal/hex memory address. */
  asAddress?: boolean;
  /** Sent only in the capability-gated `dataBreakpointInfo` request. */
  mode?: string;
}

export interface DebugDataBreakpointInfo {
  dataId: string | null;
  description: string;
  accessTypes: DebugDataBreakpointAccessType[];
  canPersist: boolean;
}

/** One exception filter advertised by the adapter's initialize response. */
export interface DebugExceptionBreakpointFilter {
  filter: string;
  label: string;
  description?: string;
  default: boolean;
  supportsCondition: boolean;
  conditionDescription?: string;
}

/** Workspace-persisted exception-breakpoint choice, scoped to one adapter. */
export interface DebugExceptionBreakpoint {
  adapterId: string;
  filterId: string;
  enabled: boolean;
  condition?: string;
  /** Adapter-advertised mode sent through `ExceptionFilterOptions`. */
  mode?: string;
}

export type DebugExceptionBreakMode = "never" | "always" | "unhandled" | "userUnhandled";

/** One segment in the adapter-defined DAP exception tree. */
export interface DebugExceptionPathSegment {
  names: string[];
  negate?: boolean;
}

/**
 * A user-defined exception class/package rule sent through DAP
 * `exceptionOptions`. Rules are persisted per workspace and adapter because
 * exception-tree names and wildcard syntax are adapter-specific.
 */
export interface DebugExceptionBreakpointRule {
  id: string;
  adapterId: string;
  path: DebugExceptionPathSegment[];
  breakMode: DebugExceptionBreakMode;
  enabled: boolean;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  /** Absolute source path, when the frame has one (library frames may not). */
  path: string | null;
  line: number;
  column: number;
  /**
   * Non-zero when the source is not a file the client can read and must be
   * fetched with the DAP `source` request — library / decompiled frames
   * (java-debug hands back attached or decompiled sources this way).
   */
  sourceReference: number;
  /** Display name from the adapter (`String.java`), for a library buffer's tab. */
  sourceName: string | null;
  /** DAP frame/source presentation hint (`subtle`, `deemphasize`, `label`…). */
  presentationHint?: string | null;
}

export interface DebugThread {
  id: number;
  name: string;
}

export type DebugStatus = "starting" | "running" | "stopped" | "terminated";

/** One console line: a debuggee `output` event or a client-side REPL echo. */
export interface DebugConsoleLine {
  /** DAP output category (`stdout`/`stderr`/`console`…) or client-side `repl`/`result`. */
  category: string;
  text: string;
  seq?: number;
  timestamp?: number;
}

/** Parsed `exceptionInfo` response (shown when stopped on an exception). */
export interface DebugExceptionInfo {
  exceptionId: string;
  description: string;
  /** Full stack trace text when the adapter provides one. */
  details: string | null;
}

/** Result of `evaluate` (and `setVariable`): display value + expandable ref. */
export interface EvaluateResult {
  value: string;
  /** Non-zero when the value is structured and expandable via `variables`. */
  variablesReference: number;
  type: string | null;
}

/** DAP `readMemory` request. Memory references are opaque adapter strings. */
export interface DebugMemoryReadRequest {
  memoryReference: string;
  offset?: number;
  count: number;
}

/** Bounded result of a DAP `readMemory` response. `data` remains base64. */
export interface DebugMemoryReadResult {
  address: string | null;
  unreadableBytes: number;
  data: string;
}

/** DAP `writeMemory` request. `data` is base64 as required by the protocol. */
export interface DebugMemoryWriteRequest {
  memoryReference: string;
  offset?: number;
  data: string;
  allowPartial?: boolean;
}

/** Result of a DAP `writeMemory` request. */
export interface DebugMemoryWriteResult {
  bytesWritten: number | null;
}

/** DAP `disassemble` request. All offsets are signed byte/instruction offsets. */
export interface DebugDisassembleRequest {
  memoryReference: string;
  offset?: number;
  instructionOffset?: number;
  instructionCount: number;
  resolveSymbols?: boolean;
}

/** Source location attached to a disassembled instruction, when available. */
export interface DebugDisassemblyLocation {
  path: string | null;
  name: string | null;
  sourceReference: number | null;
}

/** Bounded DAP `DisassembledInstruction` projection for the memory view. */
export interface DebugDisassembledInstruction {
  address: string;
  instruction: string;
  instructionBytes: string | null;
  symbol: string | null;
  location: DebugDisassemblyLocation | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
}

export interface DebugRequestToken {
  sessionId: string;
  stopEpoch: number;
  threadId?: number;
  frameId?: number;
  variablesReference?: number;
  requestId: string;
}

export type AsyncLoadState<T> =
  | { status: "idle"; }
  | { status: "loading"; token: DebugRequestToken; }
  | { status: "ready" | "partial"; token: DebugRequestToken; value: T; }
  | { status: "failed"; token: DebugRequestToken; message: string; retryable: boolean; };

export interface DebugWatchItem {
  id: string;
  expression: string;
  enabled: boolean;
  order: number;
  lastError?: string | null;
}

export interface DebugSessionState {
  sessionId: string;
  status: DebugStatus;
  stopEpoch?: number;
  /** Thread the adapter last stopped on (for stackTrace / stepping). */
  stoppedThreadId: number | null;
  stoppedReason: string | null;
  threads: DebugThread[];
  frames: DebugStackFrame[];
  /** Thread whose stack is displayed (defaults to the stopped thread). */
  selectedThreadId: number | null;
  /** Frame that variables / watches / evaluate target (defaults to the top frame). */
  selectedFrameId: number | null;
  /** Adapter-reported stack depth of the selected thread (more frames can load). */
  framesTotal?: number | null;
  /** The last stop suspended every thread (DAP `allThreadsStopped`). */
  allThreadsStopped?: boolean;
  /** Populated via `exceptionInfo` when stopped on an exception. */
  exceptionInfo: DebugExceptionInfo | null;
  /** Console lines from `output` events + client-side REPL echoes. */
  output: DebugConsoleLine[];
}

/** DAP `stepIn`/`stepOut`/`next`/`continue`/`pause`/`stepBack`/`reverseContinue` for a UI step action. */
export type DebugStepAction = "continue" | "pause" | "stepOver" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue";

/**
 * What one `setBreakpoints` call for a file will send. DAP has no "disabled"
 * flag on a breakpoint, so disabled (and, when breakpoints are muted, all)
 * entries are simply left out of the request while staying in the stored list —
 * `indexes` maps each sent entry back to its slot in `sorted` so the positional
 * response can be applied to the right stored breakpoint.
 */
export interface BreakpointSyncPlan {
  /** The full stored set for the file, sorted by line. */
  sorted: DebugBreakpoint[];
  /** The subset actually sent, in request order. */
  sent: DebugBreakpoint[];
  /** `sent[k]` is `sorted[indexes[k]]`; -1 for a transient (run-to-cursor) entry. */
  indexes: number[];
  /**
   * DAP `logMessage` for `sent[k]`, or null when the adapter must suspend so
   * the client can run the breakpoint's actions itself.
   */
  logMessages?: (string | null)[];
}

export interface FunctionBreakpointSyncPlan {
  /** Full persisted set, sorted deterministically by function name. */
  sorted: DebugFunctionBreakpoint[];
  /** Enabled entries sent to an adapter that supports function breakpoints. */
  sent: DebugFunctionBreakpoint[];
}

export interface InstructionBreakpointSyncPlan {
  /** Full persisted set, sorted deterministically across adapters. */
  sorted: DebugInstructionBreakpoint[];
  /** Entries owned by the selected adapter, including disabled ones. */
  applicable: DebugInstructionBreakpoint[];
  /** Enabled and unmuted entries sent in request order. */
  sent: DebugInstructionBreakpoint[];
}

export interface DataBreakpointSyncPlan {
  sorted: DebugDataBreakpoint[];
  /** Breakpoints owned by this adapter/session, including disabled entries. */
  applicable: DebugDataBreakpoint[];
  /** Enabled and unmuted entries sent in request order. */
  sent: DebugDataBreakpoint[];
}

/** Adapter-reported binding of one requested breakpoint. */
export interface BreakpointBinding {
  /** Adapter breakpoint id (routes later `breakpoint` events), or null. */
  id: number | null;
  verified: boolean;
  /** Line the adapter actually bound (requested line when it reports none). */
  line: number;
  /** DAP `message`: why a breakpoint could not be verified (shown to the user). */
  message?: string | null;
  /** DAP `reason`: `"pending"` (may verify later) or `"failed"` (needs action). */
  reason?: "pending" | "failed" | null;
}

/** Positional binding returned by `setFunctionBreakpoints`. */
export interface FunctionBreakpointBinding {
  id: number | null;
  verified: boolean;
  name: string;
  message?: string | null;
  reason?: "pending" | "failed" | null;
}

/** Positional binding returned by `setInstructionBreakpoints`. */
export interface InstructionBreakpointBinding {
  id: number | null;
  verified: boolean;
  key: string;
  message?: string | null;
  reason?: "pending" | "failed" | null;
}

/** Positional binding returned by `setDataBreakpoints`. */
export interface DataBreakpointBinding {
  id: number | null;
  verified: boolean;
  key: string;
  message?: string | null;
  reason?: "pending" | "failed" | null;
}

/**
 * Runtime state of one armed breakpoint for the gutter + breakpoints view.
 * `verified` = bound in the running VM; `pending` = sent but the class is not
 * loaded / not yet confirmed (grey, may still hit); `failed` = the adapter
 * cannot bind it (grey, carries a reason). A breakpoint with no entry while a
 * session is active is treated as pending, never as verified.
 */
export interface BreakpointRuntimeState {
  status: "verified" | "pending" | "failed";
  message: string | null;
}

export interface ExceptionBreakpointSyncPlan {
  /** Settings matching filters advertised by this adapter, in advertised order. */
  applicable: DebugExceptionBreakpoint[];
  /** Persisted class/package rules matching this adapter, in user order. */
  applicableRules: DebugExceptionBreakpointRule[];
  /** Enabled filters sent through the backward-compatible `filters` array. */
  plain: DebugExceptionBreakpoint[];
  /** Enabled filters sent with a condition and/or mode through `filterOptions`. */
  options: ExceptionBreakpointFilterOption[];
  /** Enabled rules sent through capability-gated `exceptionOptions`. */
  rules: DebugExceptionBreakpointRule[];
  /** Positional response order: `filters`, `filterOptions`, then `exceptionOptions`. */
  sent: ExceptionBreakpointSyncTarget[];
}

export type ExceptionBreakpointSyncTarget =
  | { kind: "filter"; breakpoint: DebugExceptionBreakpoint; }
  | { kind: "rule"; rule: DebugExceptionBreakpointRule; };

export interface ExceptionBreakpointFilterOption {
  breakpoint: DebugExceptionBreakpoint;
  condition?: string;
  mode?: string;
}

export interface ExceptionBreakpointBindingBase {
  id: number | null;
  verified: boolean;
  message?: string | null;
  reason?: "pending" | "failed" | null;
}

/** Positional binding returned by `setExceptionBreakpoints`. */
export type ExceptionBreakpointBinding =
  | (ExceptionBreakpointBindingBase & { kind: "filter"; filterId: string; })
  | (ExceptionBreakpointBindingBase & { kind: "rule"; ruleId: string; });
