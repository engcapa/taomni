import {
  completeAnyWord,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
import type {
  LspCompletionItem,
  LspCompletionResult,
  LspPosition,
  LspTextEdit,
} from "../../../lib/editor/lsp";
import { lspPositionFromOffset, offsetFromLspPosition } from "./lspPositions";

export interface LspCompletionHooks {
  fetch: (
    position: LspPosition,
    triggerCharacter: string | null,
  ) => Promise<LspCompletionResult | null>;
  resolve?: (raw: unknown) => Promise<LspCompletionItem | null>;
  triggerCharacters: () => string[];
}

/** LSP CompletionItemKind → CodeMirror completion `type` (built-in icons). */
export function completionKindToType(kind: number | null): string | undefined {
  switch (kind) {
    case 1: return "text";
    case 2: return "method";
    case 3: return "function";
    case 4: return "function"; // constructor
    case 5: return "property"; // field
    case 6: return "variable";
    case 7: return "class";
    case 8: return "interface";
    case 9: return "namespace"; // module
    case 10: return "property";
    case 13: return "enum";
    case 14: return "keyword";
    case 20: return "constant"; // enum member
    case 21: return "constant";
    case 22: return "class"; // struct
    case 24: return "keyword"; // operator
    case 25: return "type"; // type parameter
    case 11: // unit
    case 12: // value
    case 16: // color
      return "constant";
    default:
      return kind == null ? undefined : "text";
  }
}

/**
 * Convert an LSP snippet (`$1`, `${1:default}`, `${1|a,b|}`) to CodeMirror's
 * snippet syntax (`${}` / `${default}`). Tabstop order follows appearance,
 * which matches the numbering of snippets real servers emit.
 */
export function lspSnippetToCmSnippet(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\" && i + 1 < text.length) {
      // LSP escape: keep the escaped character literal; re-escape `${` so
      // CodeMirror does not read it as a field.
      const next = text[i + 1];
      out += next === "$" && text[i + 2] === "{" ? "\\$" : next;
      i += 1;
      continue;
    }
    if (char !== "$") {
      out += char;
      continue;
    }
    const rest = text.slice(i);
    const choice = rest.match(/^\$\{\d+\|([^|,}]*)[^|}]*\|\}/);
    if (choice) {
      out += `\${${choice[1]}}`;
      i += choice[0].length - 1;
      continue;
    }
    const placeholder = rest.match(/^\$\{\d+:([^{}]*)\}/);
    if (placeholder) {
      out += `\${${placeholder[1]}}`;
      i += placeholder[0].length - 1;
      continue;
    }
    const tabstop = rest.match(/^\$\{\d+\}/) ?? rest.match(/^\$\d+/);
    if (tabstop) {
      out += "${}";
      i += tabstop[0].length - 1;
      continue;
    }
    // Literal dollar; escape it when `${` would otherwise start a field.
    out += text[i + 1] === "{" ? "\\$" : "$";
  }
  return out;
}

function applyTextEdits(view: EditorView, edits: LspTextEdit[]): void {
  if (!edits.length) return;
  view.dispatch({
    changes: edits.map((edit) => ({
      from: offsetFromLspPosition(view.state.doc, edit.range.start),
      to: offsetFromLspPosition(view.state.doc, edit.range.end),
      insert: edit.newText,
    })),
  });
}

function applyLspCompletion(
  view: EditorView,
  completion: Completion,
  item: LspCompletionItem,
  from: number,
  to: number,
  resolve?: LspCompletionHooks["resolve"],
): void {
  const insert = item.textEdit?.newText ?? item.insertText ?? item.label;
  if (item.insertTextFormat === 2) {
    snippet(lspSnippetToCmSnippet(insert))(view, completion, from, to);
  } else {
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
  }
  if (item.additionalTextEdits.length) {
    applyTextEdits(view, item.additionalTextEdits);
    return;
  }
  // Servers like typescript-language-server only compute auto-import edits
  // at resolve time; fetch them after the main insertion.
  if (resolve) {
    void resolve(item.raw)
      .then((resolved) => {
        if (resolved?.additionalTextEdits.length) {
          applyTextEdits(view, resolved.additionalTextEdits);
        }
      })
      .catch(() => {});
  }
}

async function completionInfo(
  item: LspCompletionItem,
  resolve?: LspCompletionHooks["resolve"],
): Promise<Node | null> {
  let documentation = item.documentation;
  let detail = item.detail;
  if (!documentation && resolve) {
    try {
      const resolved = await resolve(item.raw);
      documentation = resolved?.documentation ?? null;
      detail = detail ?? resolved?.detail ?? null;
    } catch {
      // Keep whatever we already have.
    }
  }
  if (!documentation && !detail) return null;
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover taomni-chat-md";
  if (detail && detail !== item.label) {
    const detailEl = document.createElement("div");
    detailEl.style.fontFamily = "var(--taomni-code-font-family, monospace)";
    detailEl.style.marginBottom = documentation ? "6px" : "0";
    detailEl.textContent = detail;
    dom.appendChild(detailEl);
  }
  if (documentation) {
    const docEl = document.createElement("div");
    docEl.innerHTML = renderFormatted(documentation, "md") ?? "";
    dom.appendChild(docEl);
  }
  return dom;
}

export function createLspCompletionSource(hooks: LspCompletionHooks): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const word = context.matchBefore(/[\w$]+/);
    const charBefore = context.pos > 0
      ? context.state.sliceDoc(context.pos - 1, context.pos)
      : "";
    const isTrigger = !word && !!charBefore && hooks.triggerCharacters().includes(charBefore);
    if (!context.explicit && !word && !isTrigger) return null;

    // LSP responses are tied to a document version. Do not spend renderer time
    // mapping a response that became stale while the user kept typing.
    context.addEventListener("abort", () => {}, { onDocChange: true });
    let result: LspCompletionResult | null = null;
    try {
      result = await hooks.fetch(
        lspPositionFromOffset(context.state.doc, context.pos),
        isTrigger ? charBefore : null,
      );
    } catch {
      result = null;
    }
    if (context.aborted) return null;
    // No language service: fall back to buffer-word completion.
    if (!result || (!result.status.active && result.items.length === 0)) {
      return completeAnyWord(context);
    }
    if (result.items.length === 0) return null;

    const options = result.items.map((item): Completion => ({
      label: item.label,
      type: completionKindToType(item.kind),
      detail: item.detail ?? undefined,
      info: item.documentation || hooks.resolve
        ? () => completionInfo(item, hooks.resolve)
        : undefined,
      apply: (view, completion, from, to) =>
        applyLspCompletion(view, completion, item, from, to, hooks.resolve),
    }));
    return {
      from: word ? word.from : context.pos,
      options,
      validFor: result.isIncomplete ? undefined : /^[\w$]*$/,
    };
  };
}
