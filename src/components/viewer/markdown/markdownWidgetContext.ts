import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import type { MarkdownWarningHandler } from "./markdownRenderFallback";

export interface MarkdownWidgetContext {
  docPath: string;
  readOnly: boolean;
  theme?: "light" | "dark";
  readImage?: (reference: string) => Promise<string>;
  label: (zh: string, en: string) => string;
  onChange?: (content: string) => void;
  onError: (message: string) => void;
  onWarning?: MarkdownWarningHandler;
  replaceImage: (from: number, to: number) => void;
  revealImage: (reference: string) => void;
}

export function replaceWidgetSource(view: EditorView, from: number, raw: string, insert: string): boolean {
  if (view.state.readOnly || view.state.doc.sliceString(from, from + raw.length) !== raw) return false;
  view.dispatch({ changes: { from, to: from + raw.length, insert }, annotations: Transaction.userEvent.of("input") });
  return true;
}

export function revealSource(view: EditorView, from: number): void {
  view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
  view.focus();
}

export function widgetButton(label: string, action: () => void, text = label): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.className = "fv-icon-button";
  button.textContent = text;
  button.onmousedown = (event) => event.preventDefault();
  button.onclick = (event) => { event.preventDefault(); action(); };
  return button;
}
