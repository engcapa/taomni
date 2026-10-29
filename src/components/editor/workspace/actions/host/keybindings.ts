import { type ActionResult, type WorkspaceActionContext } from "../types";
import { type KeyboardEventLike, eventLogicalKey } from "../../workspaceCommands";
import { type KeymapSchemeV3, type Shortcut, type ShortcutStroke } from "../../workspaceKeymapScheme";
import { getLocale } from "../../../../../lib/i18n";
import { detectKeymapPlatform, formatShortcutLabel, type KeymapPlatform } from "../../workspaceKeymapPlatform";
import {
  type ActionKeybindingHostPort,
  type BindingConflictNotice,
  type BindingIndex,
  type ResolvedBindingSource,
  type ActionInvocation,
  type ResolvedBinding,
  type IndexedBinding,
  type BindingConflictEntryPoint,
  type KeyDispatchContextV2,
  type KeyDispatchResult,
} from "./types";
import { CHORD_TIMEOUT_MS, parseDefinitionKeybindings, strokeFromEvent, strokeMatchKey, normalize, hasPhysicalKeyIdentity, executeConsuming } from "./strokes";
import { freezeContext } from "./context";

export class ActionKeybindings {
  constructor(
    private readonly host: ActionKeybindingHostPort,
    private readonly onBindingConflict?: (notice: BindingConflictNotice) => void,
  ) { }
  dispose(): void {
    if (this.chordTimer !== null) clearTimeout(this.chordTimer);
    this.chordTimer = null;
    this.pendingChordStroke = null;
    this.registeredViewIds.clear();
  }

  /** Live editor view ids registered through the EditorActionBridge. */
  private readonly registeredViewIds = new Set<string>();

  /** User-editable keymap delta over definition defaults (§8.18.2). */
  private keymapScheme: KeymapSchemeV3 | null = null;

  /** Pending two-stroke chord: the already-consumed first ShortcutStroke. */
  private pendingChordStroke: ShortcutStroke | null = null;

  private chordTimer: ReturnType<typeof setTimeout> | null = null;

  private onChordStateChange?: (pending: boolean) => void;

  private bindingIndexCache: BindingIndex | null = null;

  private displayCache: {
    generation: number;
    scheme: KeymapSchemeV3 | null;
    platform: KeymapPlatform;
    locale: string;
    labels: Map<string, string[]>;
  } | null = null;

  /**
   * Install the user keymap scheme. User bindings override each action's
   * built-in defaults; disabled ids make actions unavailable everywhere while
   * keeping them visible in Search/Keymap with their reason (§8.18.2).
   */
  setKeymapScheme(scheme: KeymapSchemeV3 | null): void {
    if (this.keymapScheme === scheme) return;
    this.keymapScheme = scheme;
    this.cancelPendingChord("scheme changed");
    this.host.bumpGeneration();
  }

  getKeymapScheme(): KeymapSchemeV3 | null {
    return this.keymapScheme;
  }

  setOnChordStateChange(listener: (pending: boolean) => void): void {
    this.onChordStateChange = listener;
  }

  hasPendingChord(): boolean {
    return this.pendingChordStroke !== null;
  }

  /** EditorActionBridge registration: a live mounted editor view. */
  registerDispatchView(viewId: string): void {
    if (this.host.isDisposed()) return;
    this.registeredViewIds.add(viewId);
  }

  unregisterDispatchView(viewId: string): void {
    this.registeredViewIds.delete(viewId);
  }

  isDispatchViewRegistered(viewId: string): boolean {
    return this.registeredViewIds.has(viewId);
  }

  cancelPendingChord(reason = "cancelled"): void {
    if (this.chordTimer !== null) clearTimeout(this.chordTimer);
    this.chordTimer = null;
    const had = this.pendingChordStroke !== null;
    this.pendingChordStroke = null;
    if (had) this.onChordStateChange?.(false);
    void reason;
  }

  private armChordTimeout(): void {
    if (this.chordTimer !== null) clearTimeout(this.chordTimer);
    this.chordTimer = setTimeout(() => {
      this.cancelPendingChord("chord timeout");
    }, CHORD_TIMEOUT_MS);
  }

  /**
   * Effective shortcuts for one action: user scheme bindings win, then the
   * action's built-in defaults parsed into physical strokes.
   *
   * A PRESENT delta entry wins even when it is an empty array — that explicit
   * override is how `displaceStroke` revokes a reassigned chord from its
   * previous holder without letting the base default return (DEC-04).
   */
  effectiveShortcuts(actionId: string, platform: KeymapPlatform = detectKeymapPlatform()): { shortcuts: readonly Shortcut[]; source: ResolvedBindingSource; } {
    const scheme = this.keymapScheme;
    const userBindings = scheme?.bindings[actionId];
    if (userBindings) {
      return { shortcuts: userBindings, source: "user" };
    }
    return { shortcuts: this.baseDefinitionShortcuts(actionId, platform), source: "base" };
  }

  /** Built-in definition defaults for one action, ignoring the active scheme. */
  baseDefinitionShortcuts(actionId: string, platform: KeymapPlatform = detectKeymapPlatform()): readonly Shortcut[] {
    const action = this.host.getAction(actionId);
    if (!action) return [];
    return parseDefinitionKeybindings(action, platform);
  }

  isActionUserDisabled(actionId: string): boolean {
    return !!this.keymapScheme?.disabledActionIds.includes(actionId);
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
    const stroke = strokeFromEvent(event);
    const emptyResult: ResolvedBinding = { stroke, candidates: [], resolution: "none" };
    if (this.host.isDisposed()) return emptyResult;

    // Escape always cancels a pending chord without matching actions first?
    // No: an action may legitimately bind Escape; chord cancellation happens
    // only when the escape does not resolve to any binding below.

    const secondStroke = this.pendingChordStroke;
    const context = freezeContext(this.host.buildContext(
      invocation ?? { kind: "keyboard", eventTarget: (event as KeyboardEventLike & { target?: EventTarget; }).target },
    ));

    type Candidate = Extract<ResolvedBinding["candidates"], readonly unknown[]>[number];
    const candidates: Candidate[] = [];
    let sawEnabledCandidate = false;

    const index = this.bindingIndex();
    const matches = secondStroke
      ? index.chord.get(`${strokeMatchKey(normalize(secondStroke))}\u0001${strokeMatchKey(normalize(stroke))}`)
      : index.single.get(strokeMatchKey(normalize(stroke)));
    for (const { actionId, source } of matches ?? []) {
      const evaluation = this.host.prepareWithContext(actionId, context, "keyboard");
      candidates.push({
        actionId,
        evaluation,
        contextSpecificity: evaluation.state.availability === "available" ? 1 : 0,
        source,
      });
      if (evaluation.state.availability === "available") sawEnabledCandidate = true;
    }

    if (candidates.length === 0) {
      if (!secondStroke) {
        // A stroke that starts a registered two-stroke chord is consumed even
        // though it executes nothing itself (§8.18.2 chord wait).
        const startsChord = this.strokeStartsChord(stroke);
        if (startsChord) {
          this.pendingChordStroke = stroke;
          this.armChordTimeout();
          this.onChordStateChange?.(true);
          return {
            stroke,
            candidates: [],
            resolution: "shadowed",
            reason: "chord-pending",
          };
        }
      }
      return emptyResult;
    }

    const enabled = candidates.filter((candidate) => candidate.evaluation.state.availability === "available");
    if (enabled.length === 0) {
      return {
        stroke,
        candidates,
        resolution: "unavailable",
        reason: candidates[0]?.evaluation.state.disabledReason ?? "context blocked",
      };
    }
    if (enabled.length > 1) {
      // Two same-specificity executable candidates must not silently pick a
      // winner — surface the conflict so Keymap settings can resolve it.
      return {
        stroke,
        candidates,
        resolution: "conflict",
        reason: `${enabled.map((candidate) => candidate.actionId).join(", ")}`,
      };
    }

    return {
      stroke,
      candidates,
      resolution: candidates.length > 1 ? "single" : (sawEnabledCandidate ? "single" : "unavailable"),
      reason: undefined,
    };
  }

  private normalizeStrokeRef(stroke: ShortcutStroke): ShortcutStroke {
    return { ...stroke, key: undefined };
  }

  /**
   * Pure check (no chord state change): does any enabled workspace action bind
   * this event as a single stroke? The app shell asks this before claiming a
   * chord the IDE keymap also owns (macOS Cmd+1 Project vs Cmd+1 app tab).
   */
  claimsSingleStroke(event: Omit<KeyboardEventLike, "preventDefault" | "stopPropagation">): boolean {
    if (this.host.isDisposed()) return false;
    const matches = this.bindingIndex().single.get(strokeMatchKey(normalize(strokeFromEvent(event))));
    return !!matches?.some(({ actionId }) => !this.isActionUserDisabled(actionId));
  }

  private strokeStartsChord(stroke: ShortcutStroke): boolean {
    return this.bindingIndex().chordPrefixes.has(strokeMatchKey(this.normalizeStrokeRef(stroke)));
  }

  /** Effective keymap lookup tables, rebuilt when bindings can have changed. */
  private bindingIndex(): BindingIndex {
    const platform = detectKeymapPlatform();
    const cached = this.bindingIndexCache;
    if (
      cached
      && cached.generation === this.host.getGeneration()
      && cached.scheme === this.keymapScheme
      && cached.platform === platform
    ) return cached;
    const single = new Map<string, IndexedBinding[]>();
    const chord = new Map<string, IndexedBinding[]>();
    const chordPrefixes = new Set<string>();
    const add = (map: Map<string, IndexedBinding[]>, key: string, entry: IndexedBinding) => {
      const bucket = map.get(key);
      if (!bucket) map.set(key, [entry]);
      else if (!bucket.some((existing) => existing.actionId === entry.actionId)) bucket.push(entry);
    };
    for (const actionId of this.host.actionIds()) {
      const { shortcuts, source } = this.effectiveShortcuts(actionId, platform);
      for (const shortcut of shortcuts) {
        if (shortcut.kind !== "keyboard") continue;
        const [first, second] = shortcut.strokes;
        if (shortcut.strokes.length === 1 && first) {
          add(single, strokeMatchKey(normalize(first)), { actionId, source });
        } else if (shortcut.strokes.length === 2 && first && second) {
          const firstKey = strokeMatchKey(normalize(first));
          chordPrefixes.add(firstKey);
          add(chord, `${firstKey}\u0001${strokeMatchKey(normalize(second))}`, { actionId, source });
        }
      }
    }
    const next: BindingIndex = {
      generation: this.host.getGeneration(),
      scheme: this.keymapScheme,
      platform,
      single,
      chord,
      chordPrefixes,
    };
    this.bindingIndexCache = next;
    return next;
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
    const enabled = resolved.candidates.filter(
      (candidate) => candidate.evaluation.state.availability === "available",
    );
    const conflictIds = enabled.length > 0
      ? enabled.map((candidate) => candidate.actionId)
      : resolved.candidates.map((candidate) => candidate.actionId);
    this.onBindingConflict?.({
      keybinding: this.formatConflictDisplay(resolved.stroke),
      actionIds: conflictIds,
      entry,
      consumed,
    });
  }

  private formatConflictDisplay(stroke: ShortcutStroke): string {
    return formatShortcutLabel({ kind: "keyboard", strokes: [stroke] });
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
    if (this.host.isDisposed()) return null;
    const resolved = this.prepareBinding(event, options);
    const enabled = resolved.candidates.find(
      (candidate) => candidate.evaluation.state.availability === "available",
    );
    if (!enabled || resolved.resolution === "conflict") {
      if (resolved.resolution === "conflict") this.reportBindingConflict(resolved, "dispatch", false);
      if (
        eventLogicalKey(event) === "escape"
        && this.hasPendingChord()
        && resolved.resolution === "none"
      ) {
        // Escape with no binding cancels the chord wait (timeout/focus-loss
        // are covered elsewhere).
        this.cancelPendingChord("escape");
        event.preventDefault();
      }
      return null;
    }

    // Executed: clear any chord wait state.
    this.cancelPendingChord("executed");
    event.preventDefault();
    event.stopPropagation();
    const invocationSignal = options && "signal" in options ? options.signal : undefined;
    return {
      id: enabled.actionId,
      result: await this.host.executePrepared(enabled.evaluation, invocationSignal),
    };
  }

  /**
   * §8.19.2 typed dispatch entry. The gate runs BEFORE any binding match:
   * IME composition, dead keys and AltGr are rejected without triggering an
   * action or swallowing the character (no preventDefault on rejection).
   * Matching stays physical (`KeyboardEvent.code`); chord waits report
   * `pending-chord` with an absolute expiry.
   */
  dispatchKeydownV2(context: KeyDispatchContextV2): KeyDispatchResult {
    const { event } = context;
    if (this.host.isDisposed()) {
      return { kind: "rejected", reason: "stale-owner" };
    }
    // IME composition is rejected before any binding match. `Unidentified` is
    // only composing-like when it carries no usable physical identity: Linux
    // WebKitGTK reports real chords (notably Alt+Enter) as `key="Unidentified"`
    // while `code` still identifies the key, and rejecting those silently
    // dropped the action (AC-ALT-01).
    if (
      context.composing
      || event.isComposing === true
      || event.key === "Process"
      || (event.key === "Unidentified" && !hasPhysicalKeyIdentity(event))
    ) {
      return { kind: "rejected", reason: "composing" };
    }
    if (event.key === "Dead" || context.deadKey) {
      return { kind: "rejected", reason: "dead-key" };
    }
    const altGraph = context.altGraph || event.getModifierState?.("AltGraph") === true;

    if (context.targetViewId !== null && !this.registeredViewIds.has(context.targetViewId)) {
      // A stale view id must never let a foreign surface consume this stroke.
      return { kind: "rejected", reason: "stale-owner" };
    }

    const target = (event as KeyboardEventLike & { target?: EventTarget | null; }).target ?? null;
    const targetNode = target instanceof Node ? target : null;
    const targetEl = targetNode instanceof Element ? targetNode : targetNode?.parentElement;
    const isExternalInput = (targetEl instanceof HTMLInputElement || targetEl instanceof HTMLTextAreaElement) && !targetEl.closest?.(".cm-editor");

    const resolved = this.prepareBinding(event, {
      kind: "keyboard",
      eventTarget: target,
      context: (context.targetViewId && !isExternalInput)
        ? { focus: "editor", hasActiveFile: true, editorViewId: context.targetViewId }
        : undefined,
    });
    const key = (event.key ?? "").toLowerCase();
    const code = event.code ?? "";
    const matchesBasePhysicalKey = (code.startsWith("Key") && key === code.slice(3).toLowerCase())
      || (code.startsWith("Digit") && key === code.slice(5));
    const isRegisteredCtrlAltShortcut = resolved.candidates.length > 0
      && resolved.stroke.ctrl
      && resolved.stroke.alt
      && matchesBasePhysicalKey;
    if (altGraph && !isRegisteredCtrlAltShortcut) {
      return { kind: "rejected", reason: "alt-graph" };
    }
    if (resolved.resolution === "shadowed" && resolved.reason === "chord-pending") {
      return {
        kind: "pending-chord",
        prefix: resolved.stroke,
        expiresAt: Date.now() + CHORD_TIMEOUT_MS,
      };
    }
    if (resolved.resolution === "conflict") {
      this.reportBindingConflict(resolved, "dispatch-v2", false);
      return { kind: "rejected", reason: "conflict" };
    }
    const enabled = resolved.candidates.find(
      (candidate) => candidate.evaluation.state.availability === "available",
    );
    if (!enabled) {
      if (
        eventLogicalKey(event) === "escape"
        && this.hasPendingChord()
        && resolved.resolution === "none"
      ) {
        this.cancelPendingChord("escape");
      }
      const firstCandidate = resolved.candidates[0];
      return {
        kind: "rejected",
        reason: resolved.resolution === "unavailable" ? "disabled" : "no-match",
        actionId: firstCandidate?.actionId,
        disabledReason: firstCandidate?.evaluation.state.disabledReason,
      };
    }
    this.cancelPendingChord("executed");
    void executeConsuming(this.host, enabled.evaluation, event);
    return { kind: "executed", actionId: enabled.actionId, evaluationId: enabled.evaluation.evaluationId };
  }

  /**
   * Display strings for an action's effective shortcuts (user scheme first),
   * through the one shared formatter (ED-PARITY-013 DEC-013-02).
   */
  effectiveKeybindingDisplay(
    actionId: string,
    platform: KeymapPlatform = detectKeymapPlatform(),
    locale: string = getLocale(),
  ): string[] {
    // Rails, menus and tooltips ask for these labels on every render; cache
    // them until the bindings, platform or UI locale change.
    let cache = this.displayCache;
    if (
      !cache
      || cache.generation !== this.host.getGeneration()
      || cache.scheme !== this.keymapScheme
      || cache.platform !== platform
      || cache.locale !== locale
    ) {
      cache = { generation: this.host.getGeneration(), scheme: this.keymapScheme, platform, locale, labels: new Map() };
      this.displayCache = cache;
    }
    const cached = cache.labels.get(actionId);
    if (cached) return [...cached];
    const labels = this.effectiveShortcuts(actionId, platform).shortcuts
      .map((shortcut) => formatShortcutLabel(shortcut, platform, locale))
      .filter(Boolean);
    cache.labels.set(actionId, labels);
    return [...labels];
  }
}
