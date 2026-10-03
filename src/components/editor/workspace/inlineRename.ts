/**
 * ED-PARITY-017 DEC-017-02: in-place naming session decorations and helpers.
 *
 * The session never edits the document while the user types: the target name
 * is boxed with a mark decoration, other occurrences get a dashed box, and a
 * workspace overlay owns the input. Only Enter submits the provider rename,
 * so Escape is a guaranteed zero-modification exit.
 */
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export interface InlineRenameRange {
  from: number;
  to: number;
}

export interface InlineRenameMarks {
  target: InlineRenameRange;
  occurrences: readonly InlineRenameRange[];
}

export const setInlineRenameMarks = StateEffect.define<InlineRenameMarks | null>({
  map: (value, mapping) => value && {
    target: { from: mapping.mapPos(value.target.from), to: mapping.mapPos(value.target.to) },
    occurrences: value.occurrences.map((range) => ({
      from: mapping.mapPos(range.from),
      to: mapping.mapPos(range.to),
    })),
  },
});

const targetMark = Decoration.mark({
  class: "cm-inline-rename-target",
  attributes: { "data-inline-rename": "target" },
});
const occurrenceMark = Decoration.mark({
  class: "cm-inline-rename-occurrence",
  attributes: { "data-inline-rename": "occurrence" },
});

function buildDecorations(state: EditorState, marks: InlineRenameMarks | null): DecorationSet {
  if (!marks) return Decoration.none;
  const length = state.doc.length;
  const ranges = [
    { ...marks.target, mark: targetMark },
    ...marks.occurrences
      .filter((range) => range.from !== marks.target.from)
      .map((range) => ({ ...range, mark: occurrenceMark })),
  ]
    .filter((range) => range.from >= 0 && range.to <= length && range.from < range.to)
    .sort((a, b) => a.from - b.from);
  return Decoration.set(ranges.map((range) => range.mark.range(range.from, range.to)));
}

export const inlineRenameField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setInlineRenameMarks)) next = buildDecorations(tr.state, effect.value);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const inlineRenameTheme = EditorView.baseTheme({
  ".cm-inline-rename-target": {
    outline: "1px solid var(--taomni-code-accent, #3574f0)",
    borderRadius: "2px",
  },
  ".cm-inline-rename-occurrence": {
    outline: "1px dashed var(--taomni-code-muted, #8c8c8c)",
    borderRadius: "2px",
  },
});

/** Show (or clear with null) the session marks, installing the field once. */
export function showInlineRenameMarks(view: EditorView, marks: InlineRenameMarks | null): void {
  const installed = view.state.field(inlineRenameField, false) !== undefined;
  if (!installed) {
    if (!marks) return;
    view.dispatch({
      effects: StateEffect.appendConfig.of([inlineRenameField, inlineRenameTheme]),
    });
  }
  view.dispatch({ effects: setInlineRenameMarks.of(marks) });
}

const JAVA_KEYWORDS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
  "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
  "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native",
  "new", "package", "private", "protected", "public", "return", "short", "static", "strictfp",
  "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void",
  "volatile", "while", "true", "false", "null", "var", "record", "yield",
]);

/**
 * Local pre-check before the provider is asked. Only rejects names no
 * language accepts (empty / whitespace) plus Java-specific identifier rules;
 * the provider still owns conflicts and scoping.
 */
export function inlineRenameNameError(name: string, languageId: string | null | undefined): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name";
  if (/\s/.test(trimmed)) return `'${trimmed}' is not a valid identifier`;
  if ((languageId ?? "").toLowerCase() === "java") {
    if (!/^[A-Za-z_$][\w$]*$/.test(trimmed)) return `'${trimmed}' is not a valid identifier`;
    if (JAVA_KEYWORDS.has(trimmed)) return `'${trimmed}' is a reserved word`;
  }
  return null;
}

/**
 * IDEA-style name suggestions from the current name: the name itself, then
 * its camel-case suffixes (`stringArrayList` → `arrayList`, `list`). IDEA
 * additionally derives names from the expression type, which LSP does not
 * expose, so only the name-based part is reproduced.
 */
export function suggestInlineRenameNames(defaultName: string, limit = 5): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    if (value && !out.includes(value)) out.push(value);
  };
  push(defaultName);
  const boundaries: number[] = [];
  for (let index = 1; index < defaultName.length; index += 1) {
    const ch = defaultName[index]!;
    const prev = defaultName[index - 1]!;
    if (/[A-Z]/.test(ch) && /[a-z0-9]/.test(prev)) boundaries.push(index);
  }
  // Type names keep their leading capital (`QaOrderTarget` → `OrderTarget`).
  const typeName = /^[A-Z]/.test(defaultName);
  for (const boundary of boundaries) {
    const suffix = defaultName.slice(boundary);
    push(typeName ? suffix : suffix.charAt(0).toLowerCase() + suffix.slice(1));
  }
  return out.slice(0, limit);
}
