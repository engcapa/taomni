import type { EditorView } from "@codemirror/view";
import type { PlatformKeybindingOverrides } from "../workspaceKeymapPlatform";

export type ActionCategory =
  | "Edit"
  | "Navigate"
  | "Navigation"
  | "Refactor"
  | "Run"
  | "Build"
  | "Debug"
  | "Analyze"
  | "View"
  | "File"
  | "Git"
  | "Help"
  | "Search";

export type ActionProvenance =
  | "local"        // Implemented natively in client editor/workspace
  | "index"        // Powered by local semantic index
  | "provider"     // Delegated to external Language Server / DAP / Toolchain
  | "partial"      // Partially implemented / heuristic
  | "unsupported";
// Action placeholder / unsupported in current context

export type ActionAvailability = "available" | "disabled" | "unsupported" | "stale" | "busy";

export type ActionDisabledReason =
  | "noEditor"
  | "noSelection"
  | "readOnly"
  | "capability"
  | "providerOffline"
  | "stale"
  | "conflict"
  | "busy"
  | "disposed"
  | "invalidCondition"
  | "userDisabled"
  | "unsupported"
  | (string & {});

export interface ActionPlatformKeybindings {
  macos?: string;
  windows?: string;
  linux?: string;
  default: string;
}

export type WorkspaceFocus =
  | "workspace"
  | "editor"
  | "tree"
  | "terminal"
  | "search"
  | "completion"
  | "snippet"
  | "modal";

export interface WorkspaceActionContext {
  focus: WorkspaceFocus;
  /** Live editor view when the context carries editor focus (§8.19.2). */
  editorView?: EditorView;
  /** Stable mounted split/view identity used to select its action owner. */
  editorViewId?: string;
  hasActiveFile?: boolean;
  hasSelection?: boolean;
  isDirty?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  splitActive?: boolean;
  debugActive?: boolean;
  modalOpen?: boolean;
  readOnly?: boolean;
  languageId?: string;
  activeCapabilities?: Record<string, boolean>;
  payload?: unknown;
  [key: string]: unknown;
}

export type WhenExpr =
  | { type: "all"; exprs: WhenExpr[]; }
  | { type: "any"; exprs: WhenExpr[]; }
  | { type: "not"; expr: WhenExpr; }
  | { type: "focusIs"; target: WorkspaceFocus; }
  | { type: "hasSelection"; }
  | { type: "hasActiveFile"; }
  | { type: "isDirty"; }
  | { type: "canUndo"; }
  | { type: "canRedo"; }
  | { type: "splitActive"; }
  | { type: "debugActive"; }
  | { type: "modalOpen"; }
  | { type: "readOnly"; value?: boolean; }
  | { type: "capability"; name: string; }
  | { type: "languageIs"; languageId: string; }
  | { type: "custom"; predicate: (context: WorkspaceActionContext) => boolean; };

export interface ActionState {
  availability: ActionAvailability;
  disabledReason?: ActionDisabledReason;
  source: ActionProvenance;
  scope: "editor" | "file" | "workspace" | "session";
  freshness: "current" | "stale" | "unknown";
  completeness: "complete" | "truncated" | "partial" | "unavailable" | "failed";
}

export type ActionResultReason =
  | "aborted"
  | "busy"
  | "condition-not-met"
  | "disabled"
  | "disposed"
  | "exception"
  | "stale-owner"
  | "unknown-action"
  | "unsupported";

export interface ActionResult {
  kind: "applied" | "opened" | "no-op" | "cancelled" | "failed";
  reason?: ActionResultReason;
  undoGroupId?: string;
  message?: string;
  retryable?: boolean;
}

export interface WorkspaceActionMetadata {
  id: string;
  title: string;
  description?: string;
  category: ActionCategory;
  keybinding?: string | ActionPlatformKeybindings;
  secondaryKeybindings?: string[];
  /** Per-platform replacement sets (ED-PARITY-013 DEC-013-01). */
  platformKeybindings?: PlatformKeybindingOverrides;
  when?: string | WhenExpr | ((context: WorkspaceActionContext) => boolean);
  provenance: ActionProvenance;
  capabilityRequirement?: string;
  keywords?: string[];
}

export interface WorkspaceActionDefinition<Ctx = WorkspaceActionContext> extends WorkspaceActionMetadata {
  getState?: (context: Ctx) => ActionState;
  run: (context: Ctx, signal?: AbortSignal) => void | Promise<ActionResult | void> | ActionResult;
  isEnabled?: (context: Ctx) => boolean;
}

export type ActionRegistryEventType = "registered" | "unregistered" | "state-changed";

export interface ActionRegistryEvent {
  type: ActionRegistryEventType;
  actionId?: string;
}
