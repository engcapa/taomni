import { afterEach, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, redo } from "@codemirror/commands";
import { fireEvent } from "@testing-library/react";
import { liveMarkdown } from "./liveMarkdown";

const views: EditorView[] = [];
const context = { docPath: "/docs/table.md", readOnly: false, label: (_zh: string, en: string) => en,
  onError: () => {}, replaceImage: () => {}, revealImage: () => {} };
const source = "# Table\n\n| **Header** | Value |\n| --- | --- |\n| **死循环防护** | *italic* and `code` and ~~old~~ |\n";
function editor(readOnly = false) {
  const parent = document.createElement("div"); document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc: source,
    extensions: [history(), EditorState.readOnly.of(readOnly), liveMarkdown({ ...context, readOnly }, false)] }) });
  views.push(view);
  const cell = view.dom.querySelector<HTMLElement>("[data-cell-row='1'][data-cell-column='0']")!;
  return { view, cell };
}
afterEach(() => { views.forEach(view => view.destroy()); views.length = 0; document.body.replaceChildren(); });

it("renders inline GFM in live table headers and cells without changing source", () => {
  const { view, cell } = editor();
  expect(cell.querySelector("strong")).toHaveTextContent("死循环防护");
  expect(view.dom.querySelector("th strong")).toHaveTextContent("Header");
  expect(view.dom.querySelector("td em")).toHaveTextContent("italic");
  expect(view.dom.querySelector("td code")).toHaveTextContent("code");
  expect(view.dom.querySelector("td del")).toHaveTextContent("old");
  expect(view.state.doc.toString()).toBe(source);
});
it("edits raw markup on focus, restores formatting on blur and keeps undo/redo", () => {
  const { view, cell } = editor();
  cell.focus();
  expect(cell.textContent).toBe("**死循环防护**");
  cell.textContent = "**安全上限**"; fireEvent.input(cell);
  expect(view.state.doc.toString()).toContain("| **安全上限** |");
  expect(view.dom.querySelector("[data-cell-row='1'][data-cell-column='0']")).toBe(cell);
  cell.blur();
  expect(cell.querySelector("strong")).toHaveTextContent("安全上限");
  undo(view);
  expect(cell.querySelector("strong")).toHaveTextContent("死循环防护");
  redo(view);
  expect(cell.querySelector("strong")).toHaveTextContent("安全上限");
});
it("never strips existing markup on focus/blur or during composition", () => {
  const { view, cell } = editor();
  cell.focus(); cell.blur();
  expect(view.state.doc.toString()).toBe(source);
  cell.focus(); fireEvent.compositionStart(cell); cell.textContent = "**中文输入**"; fireEvent.input(cell);
  expect(view.state.doc.toString()).toBe(source);
  fireEvent.compositionEnd(cell); cell.blur();
  expect(cell.querySelector("strong")).toHaveTextContent("中文输入");
  expect(view.state.doc.toString()).toContain("**中文输入**");
});
it("keeps formatted readonly cells on focus and sanitizes inline HTML", () => {
  const { view, cell } = editor(true);
  cell.focus();
  expect(cell.querySelector("strong")).toHaveTextContent("死循环防护");
  fireEvent.input(cell);
  expect(view.state.doc.toString()).toBe(source);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length,
    insert: '| **Safe** | Value |\n| --- | --- |\n| <img src="https://example.invalid/image" onerror="bad()"> | [bad](javascript:alert(1)) |\n' } });
  expect(view.dom.querySelector("img[src], [onerror], a[href^='javascript:']")).toBeNull();
});
