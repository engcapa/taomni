import { type ActionResult, type ActionState, type WorkspaceActionContext, type WorkspaceActionDefinition, type WorkspaceFocus } from "../types";
import { type KeyboardEventLike } from "../../workspaceCommands";
import { type KeymapSchemeV3, type Shortcut, type ShortcutStroke } from "../../workspaceKeymapScheme";
import { type KeymapPlatform } from "../../workspaceKeymapPlatform";

export type ActionInvocationKind =
  | "direct"
  | "keyboard"
  | "search"
  | "menu"
  | "native-menu"
  | "toolbar"
  | "context-menu"
  | "cheat-sheet"
  | "snapshot";

export interface ActionInvocation {
  kind?: ActionInvocationKind;
  context?: Partial<WorkspaceActionContext>;
  payload?: unknown;
  eventTarget?: EventTarget | null;
  signal?: AbortSignal;
}

export interface PreparedActionEvaluation {
  readonly workspaceId: string;
  readonly hostGeneration: number;
  readonly actionId: string;
  readonly invocationKind: ActionInvocationKind;
  readonly context: Readonly<WorkspaceActionContext>;
  readonly state: ActionState;
  /** Runtime owner identity. Prepared evaluations cannot cross host instances. */
  readonly ownerToken: symbol;
  /** Runtime action identity. A late disposer or replacement invalidates the evaluation. */
  readonly action: WorkspaceActionDefinition | null;
  /** Stable per-evaluation identity (§8.19.2 KeyDispatchResult.evaluationId). */
  readonly evaluationId: string;
}

export interface ActionBindingConflictDiagnostic {
  kind: "binding-conflict";
  keybinding: string;
  actionIds: string[];
  winnerId: string;
}

/** Where a resolved shortcut came from (§8.18.2 ResolvedBinding.source). */
export type ResolvedBindingSource = "user" | "base" | "builtin-editor";

/** Binding resolution result for one keyboard event (§8.18.2). */
export interface ResolvedBinding {
  stroke: ShortcutStroke;
  candidates: readonly {
    actionId: string;
    evaluation: PreparedActionEvaluation;
    contextSpecificity: number;
    source: ResolvedBindingSource;
  }[];
  resolution: "single" | "shadowed" | "conflict" | "unavailable" | "none";
  reason?: string;
}

export interface ActionSnapshotItem {
  id: string;
  title: string;
  category: string;
  keybinding?: string;
  keybindings?: string[];
  /**
   * Physical EFFECTIVE shortcuts (user delta over the base defaults). This is
   * the conflict/displacement identity — never the display strings, which fork
   * on case (`Ctrl+F` vs `Ctrl+f`) and produced invisible conflicts (D1).
   */
  shortcuts?: readonly Shortcut[];
  /** Physical built-in defaults, ignoring the active scheme. */
  baseShortcuts?: readonly Shortcut[];
  /** Where `shortcuts` came from. */
  bindingSource?: ResolvedBindingSource;
  keywords?: string[];
  state: ActionState;
  evaluation: PreparedActionEvaluation;
  bindingConflicts?: ActionBindingConflictDiagnostic[];
}

/** Which dispatcher refused a stroke (ED-PARITY-004 DEC-05). */
export type BindingConflictEntryPoint = "dispatch" | "dispatch-v2" | "editor-keymap";

/**
 * The single observable conflict-rejection signal. A stroke that resolves to
 * two or more available candidates must not be silently swallowed: every entry
 * point reports it, and the editor entry additionally records whether it had to
 * consume the event to keep CodeMirror from re-interpreting the dead chord.
 */
export interface BindingConflictNotice {
  /** Display form of the contested chord, e.g. `Ctrl+F`. */
  keybinding: string;
  /** Every action that claims the stroke, in candidate order. */
  actionIds: string[];
  entry: BindingConflictEntryPoint;
  /** True when the entry called preventDefault to protect the editor. */
  consumed: boolean;
}

export interface WorkspaceActionHostOptions {
  workspaceId: string;
  getContext?: () => WorkspaceActionContext;
  getDefaultContext?: () => Partial<WorkspaceActionContext>;
  resolveFocus?: (target: EventTarget | null) => WorkspaceFocus;
  getDefaultFocus?: () => WorkspaceFocus;
  onExecuted?: (actionId: string, result: ActionResult) => void;
  /** ED-PARITY-004 DEC-05: observable rejection for ambiguous strokes. */
  onBindingConflict?: (notice: BindingConflictNotice) => void;
}

export interface IndexedBinding {
  actionId: string;
  source: ResolvedBindingSource;
}

/**
 * Keyboard lookup tables derived from the effective keymap. Rebuilt only when
 * the host generation, keymap scheme or platform changes; entries keep the
 * action registration order the previous linear scans produced.
 */
export interface BindingIndex {
  generation: number;
  scheme: KeymapSchemeV3 | null;
  platform: KeymapPlatform;
  single: Map<string, IndexedBinding[]>;
  chord: Map<string, IndexedBinding[]>;
  chordPrefixes: Set<string>;
}

/**
 * §8.19.2 dispatch context. `composing`/`deadKey`/`altGraph` are resolved by
 * the host from the event when the caller does not supply them; the caller
 * may override for tests or platform quirks. `targetViewId` must be a view
 * registered on this host (EditorActionBridge), or null for non-editor
 * surfaces.
 */
export interface KeyDispatchContextV2 {
  event: KeyboardEventLike;
  workspaceId: string;
  targetViewId: string | null;
  composing?: boolean;
  deadKey?: boolean;
  altGraph?: boolean;
}

/** §8.19.2 typed dispatch result — every outcome is explicit. */
export type KeyDispatchResult =
  | { kind: "executed"; actionId: string; evaluationId: string; }
  | { kind: "pending-chord"; prefix: ShortcutStroke; expiresAt: number; }
  | {
    kind: "rejected";
    reason: "composing" | "dead-key" | "alt-graph" | "conflict" | "disabled" | "no-match" | "stale-owner";
    actionId?: string;
    disabledReason?: string;
  };

/** A mounted editor view registered with the host's action bridge. */
export interface EditorActionBridgeViewRegistration {
  viewId: string;
  dispose(): void;
}

export interface WorkspaceActionRegistrationOptions {
  /** Restrict these dynamic action handlers to one mounted editor view. */
  ownerViewId?: string;
  /** Focused surface overrides must survive later asynchronous editor mounts. */
  priority?: number;
}

export interface ActionKeybindingHostPort {
  getGeneration(): number;
  bumpGeneration(): void;
  isDisposed(): boolean;
  actionIds(): IterableIterator<string>;
  getAction(id: string): WorkspaceActionDefinition | undefined;
  buildContext(invocation?: ActionInvocation | Partial<WorkspaceActionContext> | unknown): WorkspaceActionContext;
  prepareWithContext(id: string, context: Readonly<WorkspaceActionContext>, kind: ActionInvocationKind): PreparedActionEvaluation;
  executePrepared(prepared: PreparedActionEvaluation, signal?: AbortSignal): Promise<ActionResult>;
}
