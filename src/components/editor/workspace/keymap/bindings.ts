import { closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeSearchPanel, searchKeymap } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { type ResolvedBindingSource, type WorkspaceActionHost } from "../workspaceActionHost";
import { type ActionResult } from "../workspaceActionRegistry";
import { workspaceEditorKeymap } from "../workspaceEditorCommands";
import { buildEditorHostActions } from "./actions";
import { type CodeMirrorActionKeymapOptions, type RetainedBindingAllowlistEntry } from "./model";

/**
 * Build the single editor keymap adapter. Returned value is intended for
 * `EditorView.domEventHandlers({ keydown })` placed at Prec.high so resolved
 * actions run before generic CM primitives.
 */
export function createCodeMirrorActionKeymap(
  host: WorkspaceActionHost,
  options: CodeMirrorActionKeymapOptions,
): { keydown(event: KeyboardEvent, view: EditorView): boolean; } {
  return {
    keydown(event: KeyboardEvent, _view: EditorView): boolean {
      const allowed = new Set(options.actionIds);
      const resolved = host.prepareBinding(event, {
        kind: "keyboard",
        context: { focus: "editor", ...options.editorContextProvider() },
        eventTarget: event.target as EventTarget | null,
      });
      if (resolved.resolution === "none") return false;
      // Only bindings whose winning candidate is one of the editor-scoped
      // action ids are consumed here; everything else falls through to the
      // global window dispatcher and CM primitives.
      const enabled = resolved.candidates.find(
        (candidate) => candidate.evaluation.state.availability === "available"
          && allowed.has(candidate.actionId),
      );
      if (!enabled || resolved.resolution === "conflict") {
        if (resolved.resolution === "conflict" && resolved.candidates.some((c) => allowed.has(c.actionId))) {
          // ED-PARITY-004 DEC-05: consuming here is still required — otherwise
          // CodeMirror re-interprets the dead chord as an editing primitive. The
          // consumption is no longer silent: the host publishes the rejection so
          // the surface can name the ambiguous actions.
          event.preventDefault();
          host.reportBindingConflict(resolved, "editor-keymap", true);
          return true;
        }
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      void host.executePrepared(enabled.evaluation).then((result: ActionResult) => {
        void result;
      });
      return true;
    },
  };
}

/**
 * Action ids owned by the editor surface adapter. Escape/Tab stay
 * editor-local primitives (completion/snippet/local UI state own them), so
 * `editor.escapeSelectionStack` is registered WITHOUT a keybinding: visible
 * in Keymap/Search, dispatched through commands, never competing with the
 * CM primitive Escape stack.
 */
export const EDITOR_HOST_ACTION_IDS = [
  "editor.replace",
  "editor.expandSelection",
  "editor.escapeSelectionStack",
] as const;

/** Source label helper used by diagnostics surfaces. */
export function describeResolvedSource(source: ResolvedBindingSource): string {
  if (source === "user") return "User scheme";
  if (source === "builtin-editor") return "Built-in editor";
  return "Base scheme";
}

export const EDITOR_RETAINED_BINDING_ALLOWLIST: readonly RetainedBindingAllowlistEntry[] = [
  {
    pattern: "Escape",
    reason: "editor-local UI stack (search panel close → snippet cancel → selection collapse → signature hide) is not part of WorkspaceActionContext, and bare Escape must also cancel chord waits without executing an action",
  },
  {
    pattern: "Tab",
    reason: "browser focus navigation plus completion-accept/template/snippet precedence must run inside the editor transaction pipeline; Tab is a reserved stroke (workspaceKeymapScheme RESERVED_STROKE_CODES) so it can never be rebound",
  },
  {
    pattern: "Backspace",
    reason: "closeBrackets typing primitive — must run inside the CM input pipeline to stay IME-safe and transactional",
  },
  {
    pattern: "Enter",
    reason: "closeBrackets typing primitive — same IME-safe pipeline requirement as Backspace",
  },
  {
    pattern: "Ctrl/Cmd-click",
    reason: "platform navigation gesture owned by lspNavigationExtensions (go-to-definition); IDEA parity keeps it non-configurable rather than duplicating it as a second truth",
  },
  {
    pattern: "defaultKeymap command-primitives (Mod-Enter, Alt-l, Mod-i, Mod-[, Mod-], Alt-A, Ctrl-m)",
    reason: "generic CM editing/cursor primitives (insertBlankLine, selectLine, cursorSyntax*, indentLess/More, copyLine*, cursorMatchingBracket) stay inside the CM input pipeline; per-command migration decisions belong to later packages and must not silently rebind typing behavior",
  },
];

/**
 * Binding keys retained when an ActionHost owns dispatch. Used by the
 * inventory test to prove nothing outside this set (plus the generic
 * defaultKeymap cursor/selection primitives) reaches `keymap.of`.
 */
export const RETAINED_ESCAPE_STACK = [
  { key: "Escape", run: (view: EditorView) => closeSearchPanel(view) },
] as const;

/**
 * Canonical binding identity: all lowercase tokens (modifiers + key) sorted
 * alphabetically, joined with "+". Order-insensitive so catalog strings
 * ("Alt+Shift+ArrowUp") and CM patterns ("Shift-Alt-ArrowUp") converge.
 */
export function canonicalBindingIdentity(tokens: readonly string[]): string {
  return tokens.map((token) => token.toLowerCase()).sort().join("+");
}

/** Canonicalize a CM key pattern, expanding "Mod" to its two platforms. */
export function cmPatternIdentities(pattern: string): string[] {
  const parts = pattern.split("-").filter(Boolean);
  if (parts.length === 0) return [];
  const key = parts.pop()!;
  const mods = parts.map((mod) => mod.toLowerCase());
  const expand = (list: string[]): string => canonicalBindingIdentity([...list, key]);
  if (mods.includes("mod")) {
    const rest = mods.filter((mod) => mod !== "mod");
    return [expand([...rest, "ctrl"]), expand([...rest, "meta"])];
  }
  return [expand(mods)];
}

export const PRIMITIVE_KEYS = new Set([
  "enter",
  "backspace",
  "delete",
  "tab",
  "escape",
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "home",
  "end",
  "pageup",
  "pagedown",
]);

/** Identities of every binding an action owns (host dispatch wins these). */
export function actionOwnedPatterns(): Set<string> {
  const owned = new Set<string>();
  for (const action of buildEditorHostActions(NOOP_HANDLERS)) {
    for (const binding of [
      ...(typeof action.keybinding === "string" && action.keybinding ? [action.keybinding] : []),
      ...(action.secondaryKeybindings ?? []),
    ]) {
      if (!binding) continue;
      const parts = binding.split("+").map((part) => part.trim()).filter(Boolean);
      const key = parts.pop();
      if (!key) continue;
      if (parts.length === 0 && PRIMITIVE_KEYS.has(key.toLowerCase())) continue;
      owned.add(canonicalBindingIdentity([...parts, key]));
    }
  }
  return owned;
}

export const NOOP_HANDLERS = {
  openReplacePanel: () => false,
  expandSemanticSelection: () => false,
  startBasicCompletion: () => false,
  escapeStack: () => false,
  runEditorCommand: () => false,
};

/**
 * defaultKeymap bundles a few command-level entries (e.g. Mod-/ toggleComment,
 * Shift-Mod-k deleteLine) that migrated actions now own. With a host, those
 * entries would be a second dispatch truth behind the capture-phase window
 * dispatcher — filtered out here so only genuine cursor/selection/input
 * primitives remain.
 */
export function filterActionOwned(bindings: readonly unknown[]): readonly unknown[] {
  const owned = actionOwnedPatterns();
  return bindings.filter((binding) => {
    const key = (binding as { key?: string; }).key;
    if (!key) return true;
    return !cmPatternIdentities(key).some((identity) => owned.has(identity));
  });
}

/**
 * Build the editor-surface primitive keymap.
 *
 * - With an ActionHost (`hasActionHost: true`): only the allowlisted Escape
 *   stack, closeBrackets typing primitives, action-owned-filtered
 *   defaultKeymap cursor/selection primitives and indentWithTab remain.
 *   Business bindings resolve through the host exclusively.
 * - Without a host (standalone embedders/tests): the legacy full spread,
 *   marked transitional — every real workspace mount provides a host.
 */
let hostedPrimitiveKeybindings: readonly unknown[] | undefined;

export function buildEditorPrimitiveKeybindings(hasActionHost: boolean): readonly unknown[] {
  if (!hasActionHost) {
    return LEGACY_UNHOSTED_SPREAD;
  }
  // These bindings contain only static CodeMirror commands. Dynamic actions
  // still resolve through each editor's host adapter; do not cache that owner.
  return hostedPrimitiveKeybindings ??= [
    ...RETAINED_ESCAPE_STACK,
    ...closeBracketsKeymap,
    ...filterActionOwned(defaultKeymap),
    indentWithTab,
  ];
}

/**
 * Transitional spread for embedders that render the editor WITHOUT a
 * workspace action host. Every real workspace mount provides one, so this
 * branch is compatibility-only and must never grow new bindings.
 */
export const LEGACY_UNHOSTED_SPREAD: readonly unknown[] = [
  { key: "Escape", run: (view: EditorView) => closeSearchPanel(view) },
  ...workspaceEditorKeymap,
  ...searchKeymap,
  ...closeBracketsKeymap,
  ...defaultKeymap,
  ...historyKeymap,
  indentWithTab,
];
