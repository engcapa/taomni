import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type ParsedSnippetPlaceholder, type LspSnippetSessionState } from "./types";


/**
 * Flatten an LSP snippet into the literal text to insert plus placeholder
 * spans (defaults inlined, full [start,end) extents) so snippet + import
 * edits can be committed in a single transaction instead of the
 * helper-command double dispatch. Bare `$1`/`${1}` tabstops stay zero-width.
 * Choice placeholders keep their option list for the interactive session.
 */
export function parseLspSnippet(
  text: string,
): { text: string; placeholders: ParsedSnippetPlaceholder[]; } {
  let out = "";
  const placeholders: Array<{ start: number; choices?: readonly string[]; }> = [];
  let placeholderEnds: Array<number> = [];
  for (let i = 0;i < text.length;i += 1) {
    const char = text[i];
    if (char === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "\\" || next === "$" || next === "}") {
        out += next;
        i += 1;
        continue;
      }
      out += char;
      continue;
    }
    if (char !== "$") {
      out += char;
      continue;
    }
    const rest = text.slice(i);
    const choice = rest.match(/^\$\{(\d+)\|([^|}]*)\|\}/);
    const placeholder = rest.match(/^\$\{(\d+):((?:[^{}]|\{\d+:?[^{}]*\})*)\}/);
    const bare = rest.match(/^\$\{(\d+)\}/) ?? rest.match(/^\$(\d+)/);
    if (choice || placeholder) {
      const body = (choice ? choice[2].split(",")[0] : placeholder![2]) ?? "";
      placeholders.push({
        start: out.length,
        ...(choice ? { choices: choice[2].split(",") } : {}),
      });
      placeholderEnds.push(out.length + body.length);
      out += body;
      i += (choice ? choice[0].length : placeholder![0].length) - 1;
      continue;
    }
    if (bare) {
      placeholders.push({ start: out.length });
      placeholderEnds.push(out.length);
      i += bare[0].length - 1;
      continue;
    }
    out += char;
  }
  return {
    text: out,
    placeholders: placeholders.map((entry, index) => ({
      start: entry.start,
      end: placeholderEnds[index] ?? entry.start,
      ...(entry.choices ? { choices: entry.choices } : {}),
    })),
  };
}


export const lspSnippetSessions = new WeakMap<EditorView, LspSnippetSessionState>();


/**
 * Set while the module's own choice-cycle dispatch is in flight so the
 * doc-change invalidator does not kill the session it belongs to.
 */
export let choiceCycleInFlight = false;


export function activeLspSnippetSession(view: EditorView): boolean {
  return lspSnippetSessions.has(view);
}


/** Choice options for the ACTIVE tabstop, or null for a plain stop. */
export function activeLspSnippetChoices(view: EditorView): readonly string[] | null {
  const session = lspSnippetSessions.get(view);
  if (!session || view.state.doc.length !== session.docLength) return null;
  return session.choices[session.index] ?? null;
}


/**
 * Interactive choice placeholder (§8.18.3): Tab on a choice stop swaps the
 * committed span text for the NEXT option in one transaction and keeps the
 * tabstop session alive with remapped spans. Escape accepts the current
 * option (handled by the host's existing snippet cancel).
 */
export function cycleLspSnippetChoice(view: EditorView): boolean {
  const session = lspSnippetSessions.get(view);
  if (!session || view.state.doc.length !== session.docLength) {
    lspSnippetSessions.delete(view);
    return false;
  }
  const span = session.spans[session.index];
  const options = session.choices[session.index];
  if (!span || !options || options.length === 0) return false;

  const currentText = view.state.doc.sliceString(span.from, span.to);
  const currentIndex = options.indexOf(currentText);
  // Default (first option) shown → first Tab moves to the second option;
  // past the last option the cycle wraps back to the default.
  const nextIndex = currentIndex < 0 ? Math.min(1, options.length - 1) : (currentIndex + 1) % options.length;
  const nextText = options[nextIndex];

  choiceCycleInFlight = true;
  try {
    view.dispatch({
      changes: { from: span.from, to: span.to, insert: nextText },
      selection: { anchor: span.from, head: span.from + nextText.length },
      userEvent: "input.complete",
    });
  } finally {
    choiceCycleInFlight = false;
  }

  // Remap later spans for the length delta and keep the session usable.
  const delta = nextText.length - (span.to - span.from);
  if (delta !== 0) {
    session.spans = session.spans.map((entry, position) => (
      position === session.index
        ? { from: span.from, to: span.from + nextText.length }
        : entry.from >= span.to
          ? { from: entry.from + delta, to: entry.to + delta }
          : entry
    ));
    session.docLength += delta;
  } else {
    session.spans[session.index] = { from: span.from, to: span.from + nextText.length };
  }
  return true;
}


/** Move the selection to the next placeholder span; false when exhausted. */
export function advanceLspSnippetTabstop(view: EditorView): boolean {
  // ED-AUDIT-011: Tab during IME composition belongs to the candidate window.
  if (view.composing) return false;
  const session = lspSnippetSessions.get(view);
  if (!session || view.state.doc.length !== session.docLength) {
    lspSnippetSessions.delete(view);
    return false;
  }
  const nextIndex = session.index + 1;
  if (nextIndex >= session.spans.length) {
    // IDEA parity (§8.20 ED-AUDIT-007): the final Tab leaves the template
    // with a caret-only move instead of falling through to indent, which
    // would add a second undoable change after the acceptance and break the
    // one-undo contract.
    const span = session.spans[session.index];
    lspSnippetSessions.delete(view);
    if (!span) return false;
    view.dispatch({
      selection: { anchor: Math.min(span.to, view.state.doc.length) },
      scrollIntoView: true,
    });
    return true;
  }
  session.index = nextIndex;
  const span = session.spans[nextIndex];
  view.dispatch({
    selection: view.state.doc.length === session.docLength
      ? { anchor: Math.min(span.from, view.state.doc.length), head: Math.min(span.to, view.state.doc.length) }
      : { anchor: span.from },
    scrollIntoView: true,
  });
  return true;
}


/** Clear the active tabstop session (Escape semantics). */
export function cancelLspSnippetSession(view: EditorView): boolean {
  // ED-AUDIT-011: Escape during IME composition cancels the candidate, not the snippet.
  if (view.composing) return false;
  return lspSnippetSessions.delete(view);
}


/**
 * Shift-Tab counterpart of `advanceLspSnippetTabstop`: move back to the
 * previous placeholder span (selection-only, no history entry). While a
 * session is live the template owns Tab/Shift-Tab, so the first stop
 * re-selects itself instead of letting indentLess fire inside the template.
 */
export function retreatLspSnippetTabstop(view: EditorView): boolean {
  // ED-AUDIT-011: Shift-Tab during IME composition belongs to the candidate window.
  if (view.composing) return false;
  const session = lspSnippetSessions.get(view);
  if (!session || view.state.doc.length !== session.docLength) return false;
  session.index = Math.max(0, session.index - 1);
  const span = session.spans[session.index];
  if (!span) {
    lspSnippetSessions.delete(view);
    return false;
  }
  view.dispatch({
    selection: {
      anchor: Math.min(span.from, view.state.doc.length),
      head: Math.min(span.to, view.state.doc.length),
    },
    scrollIntoView: true,
  });
  return true;
}


/**
 * Test-only: seed a post-acceptance session exactly the way
 * `commitLspCompletion` registers one, so choice/tabstop behaviour can be
 * unit-tested without driving the full popup pipeline.
 */
export function seedLspSnippetSessionForTest(
  view: EditorView,
  snippetText: string,
): ParsedSnippetPlaceholder[] {
  const parsed = parseLspSnippet(snippetText);
  lspSnippetSessions.set(view, {
    spans: parsed.placeholders.map((placeholder) => ({ from: placeholder.start, to: placeholder.end })),
    choices: parsed.placeholders.map((placeholder) => placeholder.choices ?? null),
    index: 0,
    docLength: view.state.doc.length,
  });
  return parsed.placeholders;
}


/**
 * Update-listener fragment hosts must include so any document edit (outside
 * this module's own selection-only advances) drops the pending session
 * instead of navigating stale spans.
 */
export function lspSnippetSessionInvalidator(): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (!lspSnippetSessions.has(update.view)) return;
    // The module's own choice-cycle dispatch updates the session state right
    // after the transaction; never treat it as a foreign edit.
    if (choiceCycleInFlight) return;
    // Selection-only advances dispatched by advanceLspSnippetTabstop do not
    // change the doc; any other doc change ends the session.
    lspSnippetSessions.delete(update.view);
  });
}
