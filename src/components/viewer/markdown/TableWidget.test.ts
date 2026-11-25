import { afterEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { fireEvent } from "@testing-library/react";
import { liveMarkdown } from "./liveMarkdown";
import type { MarkdownWidgetContext } from "./markdownWidgetContext";
import { openExternalUrl } from "../../../lib/sftp";

vi.mock("../../../lib/sftp", async (original) => ({ ...await original<typeof import("../../../lib/sftp")>(), openExternalUrl: vi.fn(async () => {}) }));

const views: EditorView[] = [];
const source = "# Table\n\n| **Heading** | Other |\n| --- | --- |\n| **bold** *italic* ~~removed~~ `code` | **preserved** |\n";
function editor(content = source, readOnly = false, context: Partial<MarkdownWidgetContext> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc: content, extensions: [history(),
    EditorState.readOnly.of(readOnly), liveMarkdown({ docPath: "/docs/a.md", readOnly,
      label: (_zh, en) => en, onError: vi.fn(), replaceImage: vi.fn(), revealImage: vi.fn(), ...context }, false)] }) });
  views.push(view);
  return view;
}
function firstCell(view: EditorView) {
  return view.dom.querySelector<HTMLElement>("[data-cell-row='1'][data-cell-column='0']")!;
}
function typeIntoCell(cell: HTMLElement, text: string) {
  const selection = window.getSelection()!;
  selection.selectAllChildren(cell);
  let entered = "";
  for (const character of text) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(character);
    range.insertNode(node);
    range.setStartAfter(node); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    entered += character;
    fireEvent.input(cell, { inputType: "insertText", data: character });
    expect(cell.textContent).toBe(entered);
    expect(cell.contains(selection.anchorNode)).toBe(true);
  }
}
afterEach(() => { views.forEach((view) => view.destroy()); views.length = 0; document.body.replaceChildren(); vi.restoreAllMocks(); });

it("renders inline GFM in read-only Live tables without changing the Markdown source", () => {
  const view = editor(source, true);
  expect(view.dom.querySelector("th strong")?.textContent).toBe("Heading");
  const cell = firstCell(view);
  expect(cell.querySelector("strong")?.textContent).toBe("bold");
  expect(cell.querySelector("em")?.textContent).toBe("italic");
  expect(cell.querySelector("del")?.textContent).toBe("removed");
  expect(cell.querySelector("code")?.textContent).toBe("code");
  cell.focus();
  expect(cell.querySelector("strong")?.textContent).toBe("bold");
  expect(cell.contentEditable).not.toBe("true");
  expect(view.state.doc.toString()).toBe(source);
});

it("edits only the focused cell's raw Markdown and restores rendering after blur, Undo and Redo", async () => {
  const view = editor();
  const cell = firstCell(view);
  expect(cell.querySelector("strong")?.textContent).toBe("bold");
  cell.focus();
  expect(cell.textContent).toBe("**bold** *italic* ~~removed~~ `code`");
  expect(cell.querySelector("strong")).toBeNull();
  expect(view.state.doc.toString()).toBe(source);
  cell.textContent = "**changed** *still italic*";
  fireEvent.input(cell);
  expect(view.state.doc.toString()).toContain("| **changed** *still italic* | **preserved** |");
  expect(view.dom.querySelector("[data-cell-row='1'][data-cell-column='1'] strong")?.textContent).toBe("preserved");
  expect(firstCell(view)).toBe(cell);
  cell.blur();
  await vi.waitFor(() => expect(cell.querySelector("strong")?.textContent).toBe("changed"));
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
  expect(firstCell(view).querySelector("strong")?.textContent).toBe("bold");
  expect(redo(view)).toBe(true);
  expect(firstCell(view).querySelector("strong")?.textContent).toBe("changed");
});

it("keeps IME composition through unrelated document changes before committing source once", async () => {
  const view = editor();
  const cell = firstCell(view);
  cell.focus();
  fireEvent.compositionStart(cell);
  cell.textContent = "**中文**";
  fireEvent.input(cell);
  view.dispatch({ changes: { from: 0, insert: "Prefix\n\n" } });
  expect(cell.textContent).toBe("**中文**");
  expect(view.state.doc.toString()).toBe("Prefix\n\n" + source);
  fireEvent.compositionEnd(cell);
  expect(view.state.doc.toString()).toContain("| **中文** | **preserved** |");
  cell.blur();
  await vi.waitFor(() => expect(firstCell(view).querySelector("strong")?.textContent).toBe("中文"));
});

it("uses inline parsing, sanitized HTML and existing math rendering in table cells", () => {
  const content = "| Inline | Other |\n| --- | --- |\n| # literal heading [safe](https://example.test) <img src=x onerror=alert(1)> $x^2$<br>next | [bad](javascript:alert(1)) <script>evil()</script> |\n";
  const view = editor(content, true);
  const cell = firstCell(view);
  expect(cell.querySelector("h1")).toBeNull();
  expect(cell.textContent).toContain("# literal heading");
  expect(cell.querySelector("a")?.getAttribute("href")).toBe("https://example.test");
  expect(cell.querySelector("a")?.getAttribute("rel")).toContain("noopener");
  expect(cell.querySelector("br")).not.toBeNull();
  expect(cell.querySelector(".katex")).not.toBeNull();
  expect(cell.querySelector("img")?.hasAttribute("src")).not.toBe(true);
  expect(view.dom.querySelector("[onerror],script,a[href^='javascript:']")).toBeNull();
  expect(view.state.doc.toString()).toBe(content);
});

it("opening and leaving an editable cell does not rewrite its source or create an undo entry", () => {
  const view = editor();
  firstCell(view).focus(); firstCell(view).blur();
  expect(view.state.doc.toString()).toBe(source);
  expect(undo(view)).toBe(false);
  expect(firstCell(view).querySelector("strong")?.textContent).toBe("bold");
});

it("preserves spaces and caret through character input and undoes the typing as one change", () => {
  const view = editor();
  const cell = firstCell(view);
  cell.focus();
  typeIntoCell(cell, "**changed** *italic* ~~removed~~ `code` $x^2$");
  expect(view.state.doc.toString()).toContain("| **changed** *italic* ~~removed~~ `code` $x^2$ | **preserved** |");
  cell.blur();
  const changed = view.state.doc.toString();
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
  expect(redo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(changed);
});

it("separates cell edit sessions in history and reflects Undo inside an active cell", () => {
  const view = editor();
  const cell = firstCell(view);
  cell.focus(); typeIntoCell(cell, "first ");
  expect(cell.textContent).toBe("first ");
  expect(undo(view)).toBe(true);
  expect(cell.textContent).toBe("**bold** *italic* ~~removed~~ `code`");
  expect(redo(view)).toBe(true);
  cell.blur();
  const firstEdit = view.state.doc.toString();
  const next = view.dom.querySelector<HTMLElement>("[data-cell-row='1'][data-cell-column='1']")!;
  next.focus(); typeIntoCell(next, "**second**"); next.blur();
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(firstEdit);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
});

it.each(["Win32", "Linux x86_64", "MacIntel"])("select-all stays inside the active cell on %s without editing the document", (platform) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const view = editor();
  const cell = firstCell(view);
  cell.focus();
  const selection = window.getSelection()!;
  selection.collapse(cell.firstChild, 0);
  const outside = vi.fn();
  view.dom.addEventListener("keydown", outside);
  const chord = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
  expect(fireEvent.keyDown(cell, { key: "a", ...chord })).toBe(false);
  expect(selection.toString()).toBe("**bold** *italic* ~~removed~~ `code`");
  expect(cell.contains(selection.anchorNode)).toBe(true);
  expect(cell.contains(selection.focusNode)).toBe(true);
  expect(outside).not.toHaveBeenCalled();
  expect(view.state.doc.toString()).toBe(source);
  expect(undo(view)).toBe(false);
});

it("keeps macOS Control+A, modified chords, composition and read-only selection with their existing owners", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const view = editor();
  const cell = firstCell(view);
  cell.focus();
  const selection = window.getSelection()!;
  selection.collapse(cell.firstChild, 1);
  for (const chord of [{ ctrlKey: true }, { metaKey: true, ctrlKey: true }, { metaKey: true, altKey: true }, { metaKey: true, shiftKey: true }, { metaKey: true, isComposing: true }]) {
    expect(fireEvent.keyDown(cell, { key: "a", ...chord })).toBe(true);
    expect(selection.isCollapsed).toBe(true);
  }
  fireEvent.compositionStart(cell);
  expect(fireEvent.keyDown(cell, { key: "a", metaKey: true })).toBe(true);
  expect(selection.isCollapsed).toBe(true);
  fireEvent.compositionEnd(cell);
  const locked = editor(source, true);
  const lockedCell = firstCell(locked);
  lockedCell.focus();
  expect(fireEvent.keyDown(lockedCell, { key: "a", metaKey: true })).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
  expect(locked.state.doc.toString()).toBe(source);
});

it("opens rendered links externally without replacing them on pointer down or editing source", () => {
  const content = "| Link |\n| --- |\n| [safe](https://example.test) |\n";
  const view = editor(content);
  const anchor = firstCell(view).querySelector("a")!;
  expect(fireEvent.mouseDown(anchor)).toBe(false);
  fireEvent.click(anchor);
  expect(openExternalUrl).toHaveBeenCalledWith("https://example.test");
  expect(firstCell(view).querySelector("a")).toBe(anchor);
  expect(view.state.doc.toString()).toBe(content);
});

it.each(["edit", "destroy"])("ignores late image completion after %s and retains raw references", async (action) => {
  let resolve!: (value: string) => void;
  const readImage = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
  const content = "| Image |\n| --- |\n| ![pixel](assets/pixel.png) |\n";
  const view = editor(content, false, { readImage });
  const cell = firstCell(view);
  const image = cell.querySelector("img")!;
  expect(readImage).toHaveBeenCalledWith("assets/pixel.png");
  expect(image.hasAttribute("src")).toBe(false);
  if (action === "edit") cell.focus();
  else { view.destroy(); views.splice(views.indexOf(view), 1); }
  resolve("data:image/png;base64,fixture");
  await Promise.resolve(); await Promise.resolve();
  expect(image.hasAttribute("src")).toBe(false);
  expect(view.state.doc.toString()).toBe(content);
  if (action === "edit") expect(cell.textContent).toBe("![pixel](assets/pixel.png)");
});

it("rejects stale IME text when another update changes the same cell", () => {
  const onError = vi.fn();
  const view = editor(source, false, { onError });
  const cell = firstCell(view);
  cell.focus(); fireEvent.compositionStart(cell);
  cell.textContent = "**composing**"; fireEvent.input(cell);
  const from = view.state.doc.toString().indexOf("**bold**");
  view.dispatch({ changes: { from, to: from + 8, insert: "**external**" } });
  expect(cell.textContent).toBe("**composing**");
  fireEvent.compositionEnd(cell);
  expect(view.state.doc.toString()).toBe(source.replace("**bold**", "**external**"));
  expect(onError).toHaveBeenCalledWith("Cell changed; please enter the text again");
  expect(cell.textContent).toContain("**external**");
});
