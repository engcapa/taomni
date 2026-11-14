import type { ReactNode } from "react";

export type TaoMode = "ask" | "do" | "research";
export type TaoModel = "deepseek-flash" | "deepseek-v4-pro";
export type TaoPhase =
  | "idle"
  | "sending"
  | "thinking"
  | "searching"
  | "streaming"
  | "stopped"
  | "refusal"
  | "error"
  | "awaiting_action"
  | "plan_pending"
  | "running_workflow"
  | "budget_halt"
  | "vault_locked";
export type TaoErrorCategory = "http" | "stream" | "network" | "interrupted" | "protocol";

export interface ContextChip {
  id: string;
  kind: "terminal" | "file" | "workspace" | "database" | "note" | "local";
  label: string;
  preview?: string;
  removable?: boolean;
}

export interface TaoUsage {
  inputTokens: number;
  outputTokens: number;
  searchCalls: number;
  fetchCalls: number;
  estimatedCostCny?: number;
  priceAsOf?: string;
}

export interface TaoBudget {
  usedTokens: number;
  limitTokens: number;
  warning?: 50 | 80;
  halted: boolean;
}

export interface TaoSource {
  id: string;
  title: string;
  site?: string;
  summary?: string;
  url?: string;
  local?: boolean;
}

export type ActionKind = "run_command" | "run_sql" | "write_file" | "write_note" | "open_tab";
/** Confirmation strength for a proposed action.  The model may suggest a
 * level, but the controller/backend always recomputes it from the action
 * kind and safety policy before rendering or executing. */
export type ActionLevel = "L1" | "L2";

export interface ActionProposal {
  id: string;
  kind: ActionKind;
  level: ActionLevel;
  title: string;
  target?: { terminalId?: string; workspacePath?: string; databaseId?: string; cwd?: string };
  payload: { command?: string; sql?: string; path?: string; content?: string; tabType?: string };
  reason?: string;
  expects?: "read_only" | "write" | "external";
  status?: "pending" | "approved" | "rejected" | "completed" | "invalid";
  result?: { exitCode?: number; output?: string; durationMs?: number };
}

export interface TaoBlock {
  id: string;
  type: "thinking" | "search" | "text" | "sources" | "action" | "usage" | "error" | "plan";
  text?: string;
  query?: string;
  status?: "running" | "complete" | "error";
  sources?: TaoSource[];
  action?: ActionProposal;
  usage?: TaoUsage;
  error?: { category: "http" | "stream" | "network" | "interrupted" | "protocol"; message: string };
  steps?: Array<{ id: string; label: string; status: "pending" | "running" | "complete" | "skipped" | "failed" }>;
  manuallyExpanded?: boolean;
}

export interface TaoMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  blocks: TaoBlock[];
  createdAt: number;
}

export interface TaoThread {
  id: string;
  title: string;
  messages: TaoMessage[];
  updatedAt: number;
  source?: "tao" | "legacy" | "imported";
  running?: boolean;
}

export interface TaoRequest {
  threadId: string;
  content: string;
  mode: TaoMode;
  model: TaoModel;
  thinking: boolean;
  web: boolean;
  context: Record<string, string | undefined>;
  chips: ContextChip[];
}

export type TaoEvent =
  | { type: "message_start"; messageId?: string; model?: string; usage?: Partial<TaoUsage> }
  | { type: "block_start"; index: number; block: Partial<TaoBlock> & Pick<TaoBlock, "type"> }
  | { type: "block_delta"; index: number; delta: { text?: string; query?: string; status?: TaoBlock["status"]; sources?: TaoSource[] } }
  | { type: "block_stop"; index: number }
  | { type: "message_delta"; stopReason?: "end_turn" | "max_tokens" | "refusal" | "tool_use"; title?: string; usage?: Partial<TaoUsage> }
  | { type: "message_stop" }
  | { type: "error"; category: TaoErrorCategory; message: string };

export interface ChatBackend {
  send(request: TaoRequest, signal?: AbortSignal): Promise<AsyncIterable<TaoEvent> | Iterable<TaoEvent>>;
  stop?(threadId: string): Promise<void>;
  regenerate?(threadId: string): Promise<AsyncIterable<TaoEvent> | Iterable<TaoEvent>>;
  continue?(threadId: string): Promise<AsyncIterable<TaoEvent> | Iterable<TaoEvent>>;
}

export interface ContextPorts {
  preview?(chip: ContextChip): Promise<string> | string;
  search?(query: string): Promise<TaoSearchResult[]>;
}

export interface TaoSearchResult {
  id: string;
  source: string;
  ref: string;
  title: string;
  body: string;
  host?: string;
  ts?: number;
  useCount?: number;
  redactedCount?: number;
}

export interface ActionPorts {
  execute?(action: ActionProposal): Promise<ActionProposal["result"]>;
  reject?(action: ActionProposal): Promise<void>;
  undo?(action: ActionProposal): Promise<void>;
}

export interface BudgetPort {
  limitTokens: number;
  costConfirmThresholdCny: number;
  priceAsOf?: string;
}

export interface ChatProfile {
  modes: Array<{ id: TaoMode; label: string; description?: string }>;
  sidePanels: string[];
  defaultModel: TaoModel;
  defaultThinking: boolean;
  defaultWeb: boolean;
  budget?: Partial<BudgetPort>;
}

export interface TaoChatSlots {
  headerLeading?: ReactNode;
  headerTrailing?: ReactNode;
  composerContext?: ReactNode;
  belowComposer?: ReactNode;
  emptyState?: ReactNode;
  sidePanels?: ReactNode;
}

export interface TaoChatState {
  activeThreadId: string | null;
  threads: Record<string, TaoThread>;
  mode: TaoMode;
  context: Record<string, string | undefined>;
  composer: { text: string; chips: ContextChip[]; thinking: boolean; web: boolean; model: TaoModel };
  runtime: Record<string, {
    phase: TaoPhase;
    budget: TaoBudget;
    pendingAction?: ActionProposal;
    vaultLocked?: boolean;
    /** Request options retained for safe continuation and retry decisions. */
    lastRequest?: Pick<TaoRequest, "web" | "mode" | "model" | "thinking" | "chips" | "context">;
  }>;
  ui: { sidePanel: string | null; demoMode: boolean; searchOpen: boolean };
}

export interface TaoChatController {
  subscribe(listener: () => void): () => void;
  getState(): TaoChatState;
  setMode(mode: TaoMode): void;
  setComposerText(text: string): void;
  setComposerOption(option: "thinking" | "web", value: boolean): void;
  setModel(model: TaoModel): void;
  setContext(context: Record<string, string | undefined>): void;
  setChips(chips: ContextChip[]): void;
  setSidePanel(panel: string | null): void;
  setDemoMode(enabled: boolean): void;
  setSearchOpen(open: boolean): void;
  createThread(title?: string): string;
  setActiveThread(threadId: string): void;
  send(content?: string): Promise<boolean>;
  stop(): Promise<void>;
  continueReply(): Promise<boolean>;
  regenerate(): Promise<boolean>;
  approveAction(action: ActionProposal): Promise<void>;
  rejectAction(action: ActionProposal): Promise<void>;
  removeChip(id: string): void;
}
