import { compileWhenExpr } from "../conditions";
import { type ActionResult, type ActionState, type WorkspaceActionContext, type WorkspaceActionDefinition, type WorkspaceFocus } from "../types";
import { type KeyboardEventLike, type WorkspaceCommand, type WorkspaceCommandMenuItem } from "../../workspaceCommands";
import { type KeymapSchemeV3, type Shortcut, shortcutIdentity } from "../../workspaceKeymapScheme";
import { getLocale } from "../../../../../lib/i18n";
import { detectKeymapPlatform } from "../../workspaceKeymapPlatform";
import { ActionKeybindings } from "./keybindings";
import {
  type WorkspaceActionHostOptions,
  type ResolvedBindingSource,
  type WorkspaceActionRegistrationOptions,
  type ActionInvocation,
  type ActionInvocationKind,
  type PreparedActionEvaluation,
  type ResolvedBinding,
  type BindingConflictEntryPoint,
  type KeyDispatchContextV2,
  type KeyDispatchResult,
  type ActionBindingConflictDiagnostic,
  type ActionSnapshotItem,
} from "./types";
import { focusByPriority, unsupportedState, defaultDisabledReason, freezeContext, isPromiseLike } from "./context";
import { ActionRegistrations } from "./registrations";

export class WorkspaceActionHost {
  private readonly registrations: ActionRegistrations;

  private readonly keybindings: ActionKeybindings;

  private readonly workspaceId: string;

  private readonly ownerToken = Symbol("workspace-action-host-owner");

  private readonly getContext?: () => WorkspaceActionContext;

  private readonly getDefaultContext?: () => Partial<WorkspaceActionContext>;

  private readonly resolveFocus?: (target: EventTarget | null) => WorkspaceFocus;

  private readonly getDefaultFocus?: () => WorkspaceFocus;

  private readonly onExecuted?: (actionId: string, result: ActionResult) => void;

  private inFlightActions = new Set<string>();

  private generation = 0;

  private disposed = false;

  /** Monotonic per-host evaluation identity (§8.19.2 evaluationId). */
  private evaluationCounter = 0;

  constructor(options: WorkspaceActionHostOptions) {
    this.workspaceId = options.workspaceId;
    this.getContext = options.getContext;
    this.getDefaultContext = options.getDefaultContext;
    this.resolveFocus = options.resolveFocus;
    this.getDefaultFocus = options.getDefaultFocus;
    this.onExecuted = options.onExecuted;

    this.registrations = new ActionRegistrations({
      bumpGeneration: () => { this.generation += 1; },
      isDisposed: () => this.disposed,
    });
    this.keybindings = new ActionKeybindings({
      getGeneration: () => this.generation,
      bumpGeneration: () => { this.generation += 1; },
      isDisposed: () => this.disposed,
      actionIds: () => this.registrations.actionIds(),
      getAction: (id) => this.registrations.getAction(id),
      buildContext: (invocation) => this.buildContext(invocation),
      prepareWithContext: (id, context, kind) => this.prepareWithContext(id, context, kind),
      executePrepared: (prepared, signal) => this.executePrepared(prepared, signal),
    }, options.onBindingConflict);
  }

  getWorkspaceId(): string {
    return this.workspaceId;
  }

  getGeneration(): number {
    return this.generation;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.keybindings.dispose();
    this.inFlightActions.clear();
    this.registrations.dispose();
  }

  /**
   * Install the user keymap scheme. User bindings override each action's
   * built-in defaults; disabled ids make actions unavailable everywhere while
   * keeping them visible in Search/Keymap with their reason (§8.18.2).
   */
  setKeymapScheme(scheme: KeymapSchemeV3 | null): void {
    return this.keybindings.setKeymapScheme(scheme);
  }

  getKeymapScheme(): KeymapSchemeV3 | null {
    return this.keybindings.getKeymapScheme();
  }

  setOnChordStateChange(listener: (pending: boolean) => void): void {
    return this.keybindings.setOnChordStateChange(listener);
  }

  hasPendingChord(): boolean {
    return this.keybindings.hasPendingChord();
  }

  /** EditorActionBridge registration: a live mounted editor view. */
  registerDispatchView(viewId: string): void {
    return this.keybindings.registerDispatchView(viewId);
  }

  unregisterDispatchView(viewId: string): void {
    return this.keybindings.unregisterDispatchView(viewId);
  }

  isDispatchViewRegistered(viewId: string): boolean {
    return this.keybindings.isDispatchViewRegistered(viewId);
  }

  cancelPendingChord(reason = "cancelled"): void {
    return this.keybindings.cancelPendingChord(reason);
  }

  /**
   * Effective shortcuts for one action: user scheme bindings win, then the
   * action's built-in defaults parsed into physical strokes.
   *
   * A PRESENT delta entry wins even when it is an empty array — that explicit
   * override is how `displaceStroke` revokes a reassigned chord from its
   * previous holder without letting the base default return (DEC-04).
   */
  effectiveShortcuts(actionId: string): { shortcuts: readonly Shortcut[]; source: ResolvedBindingSource; } {
    return this.keybindings.effectiveShortcuts(actionId);
  }

  /** Built-in definition defaults for one action, ignoring the active scheme. */
  baseDefinitionShortcuts(actionId: string): readonly Shortcut[] {
    return this.keybindings.baseDefinitionShortcuts(actionId);
  }

  isActionUserDisabled(actionId: string): boolean {
    return this.keybindings.isActionUserDisabled(actionId);
  }

  registerAction(action: WorkspaceActionDefinition): () => void {
    return this.registrations.registerAction(action);
  }

  registerActions(
    actions: readonly WorkspaceActionDefinition[],
    options: WorkspaceActionRegistrationOptions = {},
  ): () => void {
    return this.registrations.registerActions(actions, options);
  }

  registerCommands(commands: readonly WorkspaceCommand[]): () => void {
    return this.registrations.registerCommands(commands);
  }

  getAction(id: string): WorkspaceActionDefinition | undefined {
    return this.registrations.getAction(id);
  }

  buildContext(
    invocation?: ActionInvocation | Partial<WorkspaceActionContext> | unknown,
  ): WorkspaceActionContext {
    const base: Partial<WorkspaceActionContext> = this.getDefaultContext
      ? this.getDefaultContext()
      : this.getContext
        ? this.getContext()
        : {};

    let explicitContext: Partial<WorkspaceActionContext> | undefined;
    let payload: unknown;
    let target: EventTarget | null = null;

    if (invocation !== undefined && invocation !== null) {
      if (typeof invocation === "object") {
        const candidate = invocation as Record<string, unknown>;
        if (
          "context" in candidate
          || "eventTarget" in candidate
          || "signal" in candidate
          || "kind" in candidate
        ) {
          explicitContext = candidate.context as Partial<WorkspaceActionContext> | undefined;
          payload = candidate.payload;
          target = (candidate.eventTarget as EventTarget | null) ?? null;
        } else if ("focus" in candidate || "payload" in candidate) {
          explicitContext = candidate as Partial<WorkspaceActionContext>;
          payload = candidate.payload;
        } else {
          payload = invocation;
        }
      } else {
        payload = invocation;
      }
    }

    const merged = { ...base, ...explicitContext };
    const candidateFocus = explicitContext?.focus
      ?? (target && this.resolveFocus ? this.resolveFocus(target) : undefined)
      ?? (this.getDefaultFocus ? this.getDefaultFocus() : undefined)
      ?? base.focus
      ?? "workspace";

    return {
      ...merged,
      focus: focusByPriority(merged, candidateFocus),
      payload: payload !== undefined ? payload : base.payload,
    };
  }

  private evaluateAction(
    action: WorkspaceActionDefinition | undefined,
    context: Readonly<WorkspaceActionContext>,
  ): ActionState {
    if (!action) return unsupportedState();
    if (this.inFlightActions.has(action.id)) {
      return {
        availability: "busy",
        disabledReason: "busy",
        source: action.provenance,
        scope: "workspace",
        freshness: "current",
        completeness: "complete",
      };
    }
    if (action.provenance === "unsupported") return unsupportedState();
    // User-disabled actions stay visible in Search/Keymap with their reason
    // but are never executable (§8.18.2 裁决).
    if (this.isActionUserDisabled(action.id)) {
      return {
        availability: "disabled",
        disabledReason: "userDisabled",
        source: action.provenance,
        scope: "workspace",
        freshness: "current",
        completeness: "complete",
      };
    }

    try {
      if (action.getState) return action.getState(context as WorkspaceActionContext);
      const whenEnabled = compileWhenExpr(action.when)(context as WorkspaceActionContext);
      const explicitlyEnabled = action.isEnabled
        ? action.isEnabled(context as WorkspaceActionContext)
        : true;
      const enabled = whenEnabled && explicitlyEnabled;
      return {
        availability: enabled ? "available" : "disabled",
        disabledReason: enabled
          ? undefined
          : defaultDisabledReason(context as WorkspaceActionContext),
        source: action.provenance,
        scope: "workspace",
        freshness: "current",
        completeness: "complete",
      };
    } catch {
      return {
        availability: "disabled",
        disabledReason: "invalidCondition",
        source: action.provenance,
        scope: "workspace",
        freshness: "current",
        completeness: "failed",
      };
    }
  }

  private prepareWithContext(
    id: string,
    context: Readonly<WorkspaceActionContext>,
    kind: ActionInvocationKind,
  ): PreparedActionEvaluation {
    const action = this.registrations.actionForContext(id, context) ?? null;
    this.evaluationCounter += 1;
    return Object.freeze({
      workspaceId: this.workspaceId,
      hostGeneration: this.generation,
      actionId: id,
      invocationKind: kind,
      context,
      state: this.evaluateAction(action ?? undefined, context),
      ownerToken: this.ownerToken,
      action,
      evaluationId: `${this.workspaceId}:e${this.evaluationCounter}`,
    });
  }

  prepare(
    id: string,
    invocation?: ActionInvocation | Partial<WorkspaceActionContext> | unknown,
    kind?: ActionInvocationKind,
  ): PreparedActionEvaluation {
    const invocationKind = kind
      ?? (invocation && typeof invocation === "object" && "kind" in invocation
        ? (invocation as ActionInvocation).kind
        : undefined)
      ?? "direct";
    return this.prepareWithContext(id, freezeContext(this.buildContext(invocation)), invocationKind);
  }

  getState(
    id: string,
    invocationOrContext?: ActionInvocation | WorkspaceActionContext | unknown,
  ): ActionState {
    return this.prepare(id, invocationOrContext).state;
  }

  async executePrepared(
    prepared: PreparedActionEvaluation,
    signal?: AbortSignal,
  ): Promise<ActionResult> {
    if (this.disposed) {
      return {
        kind: "failed",
        reason: "disposed",
        message: "Action host is disposed.",
      };
    }
    if (
      prepared.ownerToken !== this.ownerToken
      || prepared.workspaceId !== this.workspaceId
      || prepared.hostGeneration !== this.generation
      || !prepared.action
      || this.registrations.actionForContext(prepared.actionId, prepared.context) !== prepared.action
    ) {
      return {
        kind: "failed",
        reason: "stale-owner",
        message: `Action "${prepared.actionId}" evaluation is stale.`,
        retryable: true,
      };
    }
    if (signal?.aborted) {
      return {
        kind: "cancelled",
        reason: "aborted",
        message: "Action cancelled via AbortSignal.",
      };
    }
    if (prepared.state.availability !== "available") {
      return {
        kind: "no-op",
        reason: prepared.state.availability === "busy"
          ? "busy"
          : (prepared.state.disabledReason ? "disabled" : "condition-not-met"),
        message: prepared.state.disabledReason ?? `Action "${prepared.actionId}" is ${prepared.state.availability} (context blocked).`,
      };
    }
    if (this.inFlightActions.has(prepared.actionId)) {
      return {
        kind: "no-op",
        reason: "busy",
        message: `Action "${prepared.actionId}" is already executing.`,
      };
    }

    this.inFlightActions.add(prepared.actionId);
    try {
      if (signal?.aborted) {
        return {
          kind: "cancelled",
          reason: "aborted",
          message: "Action cancelled before run.",
        };
      }
      const pending = prepared.action.run(
        prepared.context as WorkspaceActionContext,
        signal,
      );
      const response = isPromiseLike<ActionResult | void>(pending)
        ? await pending
        : pending;
      const result = response ?? { kind: "applied" as const };
      this.onExecuted?.(prepared.actionId, result);
      return result;
    } catch (error) {
      const result: ActionResult = {
        kind: "failed",
        reason: "exception",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
      this.onExecuted?.(prepared.actionId, result);
      return result;
    } finally {
      this.inFlightActions.delete(prepared.actionId);
    }
  }

  async execute(
    id: string,
    invocationOrPayload?: ActionInvocation | unknown,
    signal?: AbortSignal,
  ): Promise<ActionResult> {
    const invocationSignal = invocationOrPayload
      && typeof invocationOrPayload === "object"
      && "signal" in invocationOrPayload
      ? (invocationOrPayload as ActionInvocation).signal
      : undefined;
    return this.executePrepared(
      this.prepare(id, invocationOrPayload),
      invocationSignal ?? signal,
    );
  }

  /**
   * Resolve one keyboard event against the effective keymap (§8.18.2
   * 裁决): candidates ranked by context specificity (enabled > disabled),
   * conflicts never execute. Two-stroke chords are recognized across calls.
   */
  prepareBinding(
    event: KeyboardEventLike,
    invocation?: ActionInvocation | Partial<WorkspaceActionContext> | unknown,
  ): ResolvedBinding {
    return this.keybindings.prepareBinding(event, invocation);
  }

  /**
   * Pure check (no chord state change): does any enabled workspace action bind
   * this event as a single stroke? The app shell asks this before claiming a
   * chord the IDE keymap also owns (macOS Cmd+1 Project vs Cmd+1 app tab).
   */
  claimsSingleStroke(event: Omit<KeyboardEventLike, "preventDefault" | "stopPropagation">): boolean {
    return this.keybindings.claimsSingleStroke(event);
  }

  /**
   * DEC-05 observable rejection. Every entry point funnels its ambiguous-stroke
   * decision through here so the three dispatchers cannot drift apart silently
   * again: the target action never runs, and the caller always learns why.
   */
  reportBindingConflict(
    resolved: ResolvedBinding,
    entry: BindingConflictEntryPoint,
    consumed: boolean,
  ): void {
    return this.keybindings.reportBindingConflict(resolved, entry, consumed);
  }

  /**
   * Dispatch one keyboard event through `prepareBinding`. Only an actually
   * executing binding consumes the event: unavailable candidates and
   * conflicts fall through untouched so other surfaces keep working. A bare
   * Escape cancels a pending chord.
   */
  async dispatchKeydown(
    event: KeyboardEventLike,
    options?: { eventTarget?: EventTarget | null; } | ActionInvocation,
  ): Promise<{ id: string; result: ActionResult; } | null> {
    return this.keybindings.dispatchKeydown(event, options);
  }

  /**
   * §8.19.2 typed dispatch entry. The gate runs BEFORE any binding match:
   * IME composition, dead keys and AltGr are rejected without triggering an
   * action or swallowing the character (no preventDefault on rejection).
   * Matching stays physical (`KeyboardEvent.code`); chord waits report
   * `pending-chord` with an absolute expiry.
   */
  dispatchKeydownV2(context: KeyDispatchContextV2): KeyDispatchResult {
    return this.keybindings.dispatchKeydownV2(context);
  }

  getBindingDiagnostics(
    customContext?: ActionInvocation | WorkspaceActionContext | unknown,
  ): ActionBindingConflictDiagnostic[] {
    return this.collectBindingConflicts(this.getSnapshot(customContext));
  }

  /**
   * Group available actions by PHYSICAL binding identity. Display strings are
   * never used as keys: `Ctrl+F` (base) and `Ctrl+f` (recorded) are one stroke,
   * and keying on the string hid the conflict that dispatch then refused (D1).
   */
  private collectBindingConflicts(
    snapshot: readonly ActionSnapshotItem[],
  ): ActionBindingConflictDiagnostic[] {
    const byBinding = new Map<string, { display: string; actionIds: string[]; }>();
    for (const item of snapshot) {
      if (item.state.availability !== "available") continue;
      const displays = item.keybindings ?? [];
      (item.shortcuts ?? []).forEach((shortcut, index) => {
        const identity = shortcutIdentity(shortcut);
        if (!identity) return;
        const current = byBinding.get(identity) ?? { display: displays[index] ?? "", actionIds: [] };
        if (!current.actionIds.includes(item.id)) current.actionIds.push(item.id);
        byBinding.set(identity, current);
      });
    }
    return Array.from(byBinding.values())
      .filter((entry) => entry.actionIds.length > 1)
      .map((entry) => ({
        kind: "binding-conflict",
        keybinding: entry.display,
        actionIds: entry.actionIds,
        winnerId: entry.actionIds[0],
      }));
  }

  search(
    query: string,
    customContext?: ActionInvocation | WorkspaceActionContext | unknown,
  ): WorkspaceCommandMenuItem[] {
    const q = query.trim().toLowerCase();
    return this.getSnapshot(customContext)
      .filter((item) => !q
        || item.title.toLowerCase().includes(q)
        || item.id.toLowerCase().includes(q)
        || item.category.toLowerCase().includes(q)
        || item.keywords?.some((keyword) => keyword.toLowerCase().includes(q)))
      .map((item) => ({
        id: item.id,
        title: item.title,
        category: item.category,
        keybinding: item.keybinding,
        enabled: item.state.availability === "available",
        provenance: item.state.source,
      }));
  }

  getMenuItems(
    customContext?: ActionInvocation | WorkspaceActionContext | unknown,
  ): WorkspaceCommandMenuItem[] {
    return this.search("", customContext);
  }

  /**
   * Display strings for an action's effective shortcuts (user scheme first),
   * through the one shared formatter (ED-PARITY-013 DEC-013-02).
   */
  effectiveKeybindingDisplay(actionId: string): string[] {
    return this.keybindings.effectiveKeybindingDisplay(actionId);
  }

  getSnapshot(
    customContext?: ActionInvocation | WorkspaceActionContext | unknown,
  ): ActionSnapshotItem[] {
    const context = freezeContext(this.buildContext(customContext));
    // Resolve host-backed environment getters once for this immutable catalog.
    // A later snapshot still observes platform overrides and locale changes.
    const platform = detectKeymapPlatform();
    const locale = getLocale();
    const items = Array.from(this.registrations.values()).map((action): ActionSnapshotItem => {
      // Snapshot shows the EFFECTIVE bindings (scheme override > defaults)
      // so every surface displays the same truth the dispatcher resolves.
      const { shortcuts, source } = this.keybindings.effectiveShortcuts(action.id, platform);
      const keybindings = this.keybindings.effectiveKeybindingDisplay(action.id, platform, locale);
      const evaluation = this.prepareWithContext(action.id, context, "snapshot");
      return {
        id: action.id,
        title: action.title,
        category: action.category ?? "Edit",
        keybinding: keybindings[0],
        keybindings,
        shortcuts,
        baseShortcuts: this.keybindings.baseDefinitionShortcuts(action.id, platform),
        bindingSource: source,
        keywords: action.keywords,
        state: evaluation.state,
        evaluation,
      };
    });

    const byAction = new Map<string, ActionBindingConflictDiagnostic[]>();
    for (const diagnostic of this.collectBindingConflicts(items)) {
      for (const id of diagnostic.actionIds) {
        byAction.set(id, [...(byAction.get(id) ?? []), diagnostic]);
      }
    }
    return items.map((item) => ({
      ...item,
      bindingConflicts: byAction.get(item.id),
    }));
  }
}

export function createWorkspaceActionHost(
  options: WorkspaceActionHostOptions,
): WorkspaceActionHost {
  return new WorkspaceActionHost(options);
}
