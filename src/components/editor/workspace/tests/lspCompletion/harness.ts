import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { LspCompletionResult, LspDocumentStatus } from "../../../../../lib/editor/lsp";

export function status(active: boolean): LspDocumentStatus {
  return {
    path: "a.ts",
    uri: "file:///a.ts",
    presetId: "typescript-javascript",
    languageId: "typescript",
    displayName: "TypeScript",
    available: true,
    active,
    selectedCommandId: null,
    selectedCommand: null,
    installHint: null,
    error: null,
  };
}

export function completionResult(labels: string[], active = true): LspCompletionResult {
  return {
    status: status(active),
    isIncomplete: false,
    items: labels.map((label) => ({
      label,
      kind: 3,
      detail: null,
      documentation: null,
      insertText: null,
      insertTextFormat: null,
      filterText: null,
      sortText: null,
      textEdit: null,
      additionalTextEdits: [],
      raw: { label },
    })),
  };
}

export function contextAt(docText: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc: docText });
  return new CompletionContext(state, pos, explicit);
}
