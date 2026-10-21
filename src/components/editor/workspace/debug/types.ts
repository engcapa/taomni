import type { UnlistenFn } from "@tauri-apps/api/event";
import { type DapEventPayload } from "../../../../lib/editor/dap";
import {
  type BreakpointRuntimeState,
  type DebugBreakpoint,
  type DebugDataBreakpoint,
  type DebugDataBreakpointTarget,
  type DebugDisassembleRequest,
  type DebugDisassembledInstruction,
  type DebugExceptionBreakpoint,
  type DebugExceptionBreakpointFilter,
  type DebugExceptionBreakpointRule,
  type DebugExceptionBreakMode,
  type DebugExceptionPathSegment,
  type DebugFunctionBreakpoint,
  type DebugInstructionBreakpoint,
  type DebugMemoryReadRequest,
  type DebugMemoryReadResult,
  type DebugMemoryWriteRequest,
  type DebugMemoryWriteResult,
  type DebugRequestToken,
  type DebugSessionState,
  type DebugStepAction,
  type EvaluateResult,
} from "../dapDebugModel";


/** Breakpoints keyed by absolute file path. */
export type BreakpointMap=Record<string,DebugBreakpoint[]>;


export interface DebugLaunchTarget {
  id: string;
  label: string;
  adapterId: string;
  launchConfig: Record<string,unknown>;
}


export interface DebugLaunchGroup {
  id: string;
  label: string;
  children: DebugLaunchNode[];
  parallel?: boolean;
  stopOnFailure?: boolean;
}


export type DebugLaunchNode=DebugLaunchTarget|DebugLaunchGroup;


export interface DebugSessionSummary {
  id: string;
  targetId: string;
  label: string;
  adapterId: string;
  status: DebugSessionState["status"];
  stoppedReason: string|null;
}


export interface DataBreakpointAddResult {
  added: boolean;
  message: string;
}


export interface DebugActionResult {
  kind: "applied"|"no-op"|"failed";
  message?: string;
}


export interface WatchExpressionItem {
  id: string;
  expression: string;
  enabled?: boolean;
}


export interface CodeDebugSession {
  /** Current session state (null when no debug session is active). */
  state: DebugSessionState|null;
  /** Breakpoint configurations, keyed by file path. */
  breakpoints: BreakpointMap;
  /** Adapter binding state per path → line → runtime status (session-scoped). */
  breakpointRuntime: Record<string,Record<number,BreakpointRuntimeState>>;
  /** Persistent DAP function/method breakpoints, shared by compound children. */
  functionBreakpoints: DebugFunctionBreakpoint[];
  /** Function binding state for the selected adapter session. */
  functionBreakpointRuntime: Record<string,BreakpointRuntimeState>;
  /** Adapter-scoped instruction/address breakpoints. */
  instructionBreakpoints: DebugInstructionBreakpoint[];
  /** Instruction binding state for the selected adapter session. */
  instructionBreakpointRuntime: Record<string,BreakpointRuntimeState>;
  /** Persistent adapter-scoped and transient session-scoped data breakpoints. */
  dataBreakpoints: DebugDataBreakpoint[];
  /** Data-breakpoint binding state for the selected adapter session. */
  dataBreakpointRuntime: Record<string,BreakpointRuntimeState>;
  /** Persistent adapter-scoped exception-filter choices and conditions. */
  exceptionBreakpoints: DebugExceptionBreakpoint[];
  /** Exception-filter binding state for the selected adapter session. */
  exceptionBreakpointRuntime: Record<string,BreakpointRuntimeState>;
  /** Persistent adapter-scoped class/package exception rules. */
  exceptionBreakpointRules: DebugExceptionBreakpointRule[];
  /** Exception-rule binding state for the selected adapter session. */
  exceptionBreakpointRuleRuntime: Record<string,BreakpointRuntimeState>;
  /** Adapter capabilities from `initialize` — gates optional UI (restartFrame, setVariable…). */
  capabilities: Record<string,unknown>;
  /** Exception-breakpoint filter ids the adapter advertised (D5). */
  availableExceptionFilters: DebugExceptionBreakpointFilter[];
  /** Persistent watch expressions (the panel evaluates them per stop). */
  watchExpressions: string[];
  /** Structured watch items with stable IDs. */
  watchItems: WatchExpressionItem[];
  /** Monotonically increasing epoch bumped on every debug stop event. */
  stopEpoch: number;
  /** Stepping action in-flight status. */
  isStepping: boolean;
  /** IDEA "Mute Breakpoints": keep them listed but stop arming them. */
  breakpointsMuted: boolean;
  setBreakpointsMuted: (muted: boolean) => void;
  /** Remove every breakpoint in the workspace (IDEA's breakpoints dialog). */
  removeAllBreakpoints: () => void;
  /** Locals of the selected frame as `name → value`, for editor inline values. */
  frameVariables: Record<string,string>;
  /** Every child in the current single or compound debug launch. */
  sessions: DebugSessionSummary[];
  /** Session shown by the stack, variables, watches and console views. */
  activeSessionId: string|null;
  selectSession: (sessionId: string) => void;
  /** Start a debug session with a resolved launch config (adapter defaults to Java). */
  startDebug: (launchConfig: Record<string,unknown>,adapterId?: string) => Promise<void>;
  /** Start a validated compound launch while retaining every child DAP session. */
  startDebugGroup: (plan: DebugLaunchGroup) => Promise<void>;
  /** Re-run the last launch config (IDEA rerun). */
  restart: () => void;
  canRestart: boolean;
  toggleBreakpoint: (path: string,line: number) => void;
  /** Add (or update) a line breakpoint with IDEA properties (temporary, logging…). */
  addBreakpoint: (path: string,line: number,options?: Partial<DebugBreakpoint>) => void;
  /** IDEA middle-click: flip a breakpoint's enabled state. */
  toggleBreakpointEnabled: (path: string,line: number) => void;
  setBreakpointOptions: (path: string,line: number,options: Partial<DebugBreakpoint>) => void;
  /** Persist a source-breakpoint mode for the active adapter only. */
  setBreakpointMode: (path: string,line: number,mode: string) => void;
  /** Remove one breakpoint outright (breakpoints view). */
  removeBreakpoint: (path: string,line: number) => void;
  addFunctionBreakpoint: (name: string) => void;
  setFunctionBreakpointOptions: (name: string,options: Partial<DebugFunctionBreakpoint>) => void;
  removeFunctionBreakpoint: (name: string) => void;
  addInstructionBreakpoint: (target: {
    instructionReference: string;
    offset?: number;
    mode?: string;
  }) => boolean;
  setInstructionBreakpointOptions: (
    key: string,
    options: Partial<Pick<DebugInstructionBreakpoint,"enabled"|"condition"|"hitCondition"|"mode">>,
  ) => void;
  removeInstructionBreakpoint: (key: string) => void;
  addDataBreakpoint: (target: DebugDataBreakpointTarget) => Promise<DataBreakpointAddResult>;
  setDataBreakpointOptions: (key: string,options: Partial<DebugDataBreakpoint>) => void;
  removeDataBreakpoint: (key: string) => void;
  setExceptionBreakpointOptions: (
    filterId: string,
    options: Partial<Pick<DebugExceptionBreakpoint,"enabled"|"condition"|"mode">>,
  ) => void;
  addExceptionBreakpointRule: (
    path: DebugExceptionPathSegment[],
    breakMode?: DebugExceptionBreakMode,
  ) => string|null;
  setExceptionBreakpointRuleOptions: (
    ruleId: string,
    options: Partial<Pick<DebugExceptionBreakpointRule,"enabled"|"path"|"breakMode">>,
  ) => void;
  removeExceptionBreakpointRule: (ruleId: string) => void;
  addWatchExpression: (expr: string) => string|void;
  removeWatchExpression: (target: number|string) => void;
  step: (action: DebugStepAction) => Promise<DebugActionResult>;
  /** Continue to a line via a transient breakpoint (IDEA Run to Cursor). */
  runToCursor: (path: string,line: number) => void;
  /** Show another thread's stack while stopped. */
  selectThread: (threadId: number) => void;
  /** Pick the frame that variables / watches / evaluate target. */
  selectFrame: (frameId: number) => void;
  /** Fetch the next page of the shown thread's stack (IDEA lazy frames). */
  loadMoreFrames: () => Promise<void>;
  /** Re-enter a frame from its start (IDEA Drop Frame; capability-gated). */
  restartFrame: (frameId: number) => void;
  /** Hot-reload changed classes (java-debug `redefineClasses`); best-effort (D5). */
  hotReload: () => void;
  evaluate: (expression: string,context?: string) => Promise<EvaluateResult>;
  /**
   * Evaluate for an editor hover (IDEA's inspect-on-hover). Resolves to null
   * when the session is not stopped or the expression cannot be evaluated, so
   * the editor simply shows no tooltip.
   */
  hoverEvaluate: (expression: string) => Promise<EvaluateResult|null>;
  /** Read adapter memory through the standard DAP request (capability-gated). */
  readMemory: (request: DebugMemoryReadRequest) => Promise<DebugMemoryReadResult|null>;
  /** Write adapter memory through the standard DAP request (capability-gated). */
  writeMemory: (request: DebugMemoryWriteRequest) => Promise<DebugMemoryWriteResult|null>;
  /** Disassemble an adapter memory range through the standard DAP request. */
  disassemble: (request: DebugDisassembleRequest) => Promise<DebugDisassembledInstruction[]>;
  /** Change a variable's value (DAP `setVariable`; capability-gated). */
  setVariable: (variablesReference: number,name: string,value: string) => Promise<EvaluateResult|null>;
  /** Append a client-side line (REPL echo / result) to the session console. */
  logConsole: (category: string,text: string) => void;
  /** Empty the console without touching the session. */
  clearConsole: () => void;
  /** Generation counter incremented on clearConsole and session changes to prevent late callback resurrections. */
  consoleGeneration: number;
  /**
   * Surface a launch/pre-launch failure in the Debug panel (not just the status
   * bar) so a debug attempt that dies before a session exists is visible rather
   * than looking like "nothing happened". Seeds a `terminated` session carrying
   * the message on the console when there is none yet.
   */
  reportStartupFailure: (message: string) => void;
  /**
   * Report a pre-launch step (save → build → resolve main class) in the Debug
   * panel. The phase before the adapter exists can take tens of seconds on a
   * cold project; without this the panel shows its "no debug session"
   * placeholder the whole time and the click looks ignored.
   */
  reportStartupProgress: (message: string) => void;
  /** Fetch variables for a `variablesReference` (D4/D8.4 token-guarded). */
  fetchVariables: (variablesReference: number,token?: DebugRequestToken) => Promise<unknown>;
  /** Fetch scopes for a stack frame (D4/D8.4 token-guarded). */
  fetchScopes: (frameId: number,token?: DebugRequestToken) => Promise<unknown>;
  /**
   * Fetch a library / decompiled frame's source text (DAP `source`), so a stack
   * frame outside the workspace still opens — IDEA's decompiled-source view.
   * Null when the adapter cannot produce it.
   */
  fetchSource: (sourceReference: number) => Promise<string|null>;
  terminate: () => void;
  /** Source location to highlight as "current" (selected frame, else top frame). */
  currentLocation: { path: string; line: number; }|null;
}


export interface DebugSessionRecord {
  id: string;
  order: number;
  targetId: string;
  label: string;
  adapterId: string;
  launchConfig: Record<string,unknown>;
  state: DebugSessionState;
  capabilities: Record<string,unknown>;
  availableFilters: DebugExceptionBreakpointFilter[];
  breakpointRuntime: Record<string,Record<number,BreakpointRuntimeState>>;
  functionBreakpointRuntime: Record<string,BreakpointRuntimeState>;
  instructionBreakpointRuntime: Record<string,BreakpointRuntimeState>;
  dataBreakpointRuntime: Record<string,BreakpointRuntimeState>;
  exceptionBreakpointRuntime: Record<string,BreakpointRuntimeState>;
  exceptionBreakpointRuleRuntime: Record<string,BreakpointRuntimeState>;
  frameVariables: Record<string,string>;
  initialized: boolean;
  launchAccepted: boolean;
  live: boolean;
  unlisten: UnlistenFn|null;
  stopEpoch: number;
  bpIdIndex: Map<number,
    |{ kind: "source"; path: string; }
    |{ kind: "function"; name: string; }
    |{ kind: "instruction"; key: string; }
    |{ kind: "data"; key: string; }
    |{ kind: "exception-filter"; filterId: string; }
    |{ kind: "exception-rule"; ruleId: string; }
  >;
  syncGeneration: Map<string,number>;
  functionSyncGeneration: number;
  instructionSyncGeneration: number;
  dataSyncGeneration: number;
  exceptionSyncGeneration: number;
  tempRunToCursor: { path: string; }|null;
  /** Dependent breakpoints armed by a master hit (IDEA "Disable until…"). */
  armedDependents: Set<string>;
  /**
   * While a breakpoint stop is checked for a pass-through (non-suspending)
   * hit, later events queue here so they keep their order.
   */
  eventGate: { queue: DapEventPayload[]; }|null;
  /**
   * `exited`/`terminated` held while the debuggee's last output drains: the
   * adapter's stream reader can deliver stdout after the exit events.
   */
  closing: { events: DapEventPayload[]; timer: ReturnType<typeof setTimeout>|null; }|null;
  abortScopeIds: string[];
  ready: Promise<void>;
  readyResolve: () => void;
  readyReject: (error: unknown) => void;
  readySettled: boolean;
}


export type LastDebugLaunch=
  |{ kind: "single"; config: Record<string,unknown>; adapterId: string; }
  |{ kind: "group"; plan: DebugLaunchGroup; };
