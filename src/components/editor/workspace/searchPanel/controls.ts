import { SearchQuery } from "@codemirror/search";
import { EditorView } from "@codemirror/view";

export function button(label: string, text: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cm-workspace-search-button";
  element.setAttribute("aria-label", label);
  element.title = label;
  element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

export function input(
  label: string,
  name: string,
  placeholder: string,
  type: "search" | "text" = "text",
): HTMLInputElement {
  const element = document.createElement("input");
  element.type = type;
  element.className = "cm-workspace-search-input";
  element.name = name;
  element.placeholder = placeholder;
  element.setAttribute("aria-label", label);
  element.autocomplete = "off";
  element.spellcheck = false;
  return element;
}

export function fieldShell(field: HTMLElement): HTMLDivElement {
  const shell = document.createElement("div");
  shell.className = "cm-workspace-search-field";
  shell.append(field);
  return shell;
}

export function matchStatus(view: EditorView, query: SearchQuery): string {
  // IDEA wording (ED-PARITY-012 A2): "0 results", "N results", "i/N".
  if (!query.search) return "0 results";
  if (!query.valid) return "Invalid pattern";
  const matches: Array<{ from: number; to: number; }> = [];
  const cursor = query.getCursor(view.state);
  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    matches.push(item.value);
  }
  if (matches.length === 0) return "0 results";
  const selection = view.state.selection.main;
  const current = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
  return current === -1 ? `${matches.length} results` : `${current + 1} / ${matches.length}`;
}
