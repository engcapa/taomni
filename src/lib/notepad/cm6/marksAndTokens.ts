import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { NotepadMarkRule } from "../../../stores/notepadStore";
import {
  buildSearchRegExp,
  hasCatastrophicBacktrackingRisk,
  type NotepadSearchMode,
} from "../transforms/escape";

export interface FindHighlightSpec {
  query: string;
  mode: NotepadSearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  dotAll: boolean;
}

export interface MarkHighlightPayload {
  rules: NotepadMarkRule[];
  activeMatch?: { from: number; to: number } | null;
  findHighlight?: FindHighlightSpec | null;
}

export const setMarkHighlightsEffect = StateEffect.define<MarkHighlightPayload>();

const MAX_DECORATIONS_PER_DOC = 5000;

interface SpanItem {
  from: number;
  to: number;
  className: string;
}

export function computeMarkSpans(text: string, payload: MarkHighlightPayload): SpanItem[] {
  const spans: SpanItem[] = [];
  for (const rule of payload.rules) {
    if (!rule.query) continue;
    let regex: RegExp | null = null;
    try {
      regex = buildSearchRegExp(
        {
          query: rule.query,
          mode: rule.mode,
          caseSensitive: rule.caseSensitive,
          wholeWord: rule.wholeWord,
          dotAll: false,
        },
        true,
      );
    } catch {
      continue;
    }
    if (!regex) continue;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      spans.push({
        from: m.index,
        to: m.index + m[0].length,
        className: `np-mark-style-${Math.max(0, Math.min(5, rule.style))}`,
      });
      if (spans.length >= MAX_DECORATIONS_PER_DOC) break;
    }
    if (spans.length >= MAX_DECORATIONS_PER_DOC) break;
  }

  if (
    payload.findHighlight?.query &&
    !(payload.findHighlight.mode === "re" && hasCatastrophicBacktrackingRisk(payload.findHighlight.query))
  ) {
    let findRe: RegExp | null = null;
    try {
      findRe = buildSearchRegExp(payload.findHighlight, true);
    } catch {
      findRe = null;
    }
    if (findRe) {
      findRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = findRe.exec(text)) !== null) {
        if (m[0].length === 0) {
          findRe.lastIndex += 1;
          continue;
        }
        spans.push({
          from: m.index,
          to: m.index + m[0].length,
          className: "np-search-all-match",
        });
        if (spans.length >= MAX_DECORATIONS_PER_DOC) break;
      }
    }
  }

  if (
    payload.activeMatch &&
    payload.activeMatch.to > payload.activeMatch.from &&
    payload.activeMatch.to <= text.length
  ) {
    spans.push({
      from: payload.activeMatch.from,
      to: payload.activeMatch.to,
      className: "np-search-active-match",
    });
  }

  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  return spans;
}

function buildDecorations(text: string, payload: MarkHighlightPayload): DecorationSet {
  const spans = computeMarkSpans(text, payload);
  if (spans.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const span of spans) {
    builder.add(span.from, span.to, Decoration.mark({ class: span.className }));
  }
  return builder.finish();
}

export function createMarksExtension(initialPayload: MarkHighlightPayload = { rules: [] }): Extension {
  const payloadField = StateField.define<MarkHighlightPayload>({
    create: () => initialPayload,
    update(val, tr) {
      for (const e of tr.effects) {
        if (e.is(setMarkHighlightsEffect)) return e.value;
      }
      return val;
    },
  });

  const decosField = StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state.doc.toString(), state.field(payloadField)),
    update(decos, tr) {
      const payloadChanged = tr.effects.some((e) => e.is(setMarkHighlightsEffect));
      if (!payloadChanged && !tr.docChanged) return decos;
      return buildDecorations(tr.state.doc.toString(), tr.state.field(payloadField));
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return [payloadField, decosField];
}

export function extractMarkedMatchesText(text: string, rules: NotepadMarkRule[], styleFilter?: number): string {
  const filtered = styleFilter === undefined ? rules : rules.filter((r) => r.style === styleFilter);
  const spans = computeMarkSpans(text, { rules: filtered });
  return spans.map((s) => text.slice(s.from, s.to)).join("\n");
}

export function jumpMarkSpan(
  text: string,
  rules: NotepadMarkRule[],
  styleFilter: number | undefined,
  cursorPos: number,
  backward: boolean,
): { from: number; to: number } | null {
  const filtered = styleFilter === undefined ? rules : rules.filter((r) => r.style === styleFilter);
  const spans = computeMarkSpans(text, { rules: filtered });
  if (spans.length === 0) return null;
  if (backward) {
    const prev = [...spans].reverse().find((s) => s.to <= cursorPos);
    return prev ?? spans[spans.length - 1];
  }
  const next = spans.find((s) => s.from >= cursorPos);
  return next ?? spans[0];
}
