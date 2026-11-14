import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { fireEvent } from "@testing-library/react";
import { liveMarkdown } from "./liveMarkdown";
import { markdownInput, insertMarkdownImages } from "./markdownInput";
import { saveMarkdownImage } from "../../../lib/markdownAssets";
import { formatMarkdown, setMarkdownHeading } from "./markdownCommands";

vi.mock("../../../lib/markdownAssets", async (original) => ({ ...await original<typeof import("../../../lib/markdownAssets")>(), saveMarkdownImage: vi.fn() }));
const editors: EditorView[] = [];
const label = (_zh: string, en: string) => en;
const context = { docPath: "/docs/a.md", readOnly: false, label, onError: vi.fn(), replaceImage: vi.fn(), revealImage: vi.fn() };
function editor(content: string, extra: import("@codemirror/state").Extension[] = [], anchor = 0) {
  const parent = document.createElement("div"); document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc: content, selection: { anchor }, extensions: [history(), ...extra] }) });
  editors.push(view); return view;
}
function paste(view: EditorView, plain: string, html = "") {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { items: [], getData: (type: string) => type === "text/html" ? html : plain } });
  view.contentDOM.dispatchEvent(event);
}
const onError = vi.fn(), onStatus = vi.fn();
function input() { return markdownInput({ docPath: "/docs/a.md", label, onError, onStatus,
  preferences: () => ({ markdownImageDir: "assets", markdownImageTemplate: "image.png", convertTables: true }) }); }
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { editors.forEach((view) => view.destroy()); editors.length = 0; document.body.replaceChildren(); });

describe("live Markdown decorations and standard-source widgets", () => {
  it("renders inactive blocks and restores raw source for the current block without rewriting it", () => {
    const source = "# Title\n\nA **bold** line\n\n> Quote\n";
    const view = editor(source, [liveMarkdown(context, false)]);
    expect(view.dom.querySelector("strong")?.textContent).toBe("bold");
    expect(view.dom.querySelector("blockquote")?.textContent?.trim()).toBe("Quote");
    expect(view.contentDOM.textContent).toContain("# Title");
    view.dispatch({ selection: { anchor: source.indexOf("A **") + 2 } });
    expect(view.contentDOM.textContent).toContain("A **bold** line");
    expect(view.dom.querySelector("h1")?.textContent).toBe("Title");
    expect(view.state.doc.toString()).toBe(source);
  });
  it("does not leave source separator lines between consecutive rendered blocks", () => {
    const source = "# Title\n\nParagraph\n\n## Details\n\n> Quote\n\n";
    const view = editor(source, [liveMarkdown(context, false)]);
    const paragraph = view.contentDOM.querySelector(".fv-md-rendered-block")!;
    expect(paragraph.textContent?.trim()).toBe("Paragraph");
    expect(paragraph.nextElementSibling).toHaveClass("fv-md-rendered-block");
    expect(view.state.doc.toString()).toBe(source);
    const blank = source.indexOf("\n\n##") + 1;
    view.dispatch({ selection: { anchor: blank } });
    expect(view.state.doc.toString()).toBe(source);
    expect(view.contentDOM.querySelector(".fv-md-current-line")).not.toBeNull();
    view.dispatch({ changes: { from: blank, insert: "editable" }, selection: { anchor: blank + 8 } });
    expect(view.state.doc.toString()).toBe(source.slice(0, blank) + "editable" + source.slice(blank));
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(view.contentDOM.querySelector(".fv-md-current-line")).not.toBeNull();
  });
  it("toggles actual task source via checkbox and remains undoable", () => {
    const source = "# Tasks\n\n- [ ] todo\n- [x] done\n";
    const view = editor(source, [liveMarkdown(context, false)]);
    const checkbox = view.dom.querySelector<HTMLButtonElement>("[role='checkbox']");
    expect(checkbox).not.toBeNull();
    expect(view.dom.querySelectorAll("[role='checkbox']")).toHaveLength(2);
    expect(view.dom.querySelector(".fv-md-task-state")).toBeNull();
    expect(view.dom.querySelector('[aria-label="done"]')).toHaveAttribute("aria-checked", "true");
    fireEvent.click(checkbox!);
    expect(view.state.doc.toString()).toContain("- [x] todo");
    undo(view); expect(view.state.doc.toString()).toBe(source);
  });
  it("edits table cells into standard GFM and updates the same live cell", () => {
    const source = "# Table\n\n| A | B |\n| --- | --- |\n| c | d |\n";
    const view = editor(source, [liveMarkdown(context, false)]);
    const cell = view.dom.querySelector<HTMLElement>("[data-cell-row='1'][data-cell-column='0']")!;
    expect(cell).not.toBeNull();
    cell.focus(); cell.textContent = "new | value"; fireEvent.input(cell);
    expect(view.state.doc.toString()).toContain("| new \\| value | d |");
    expect(view.dom.querySelector("[data-cell-row='1'][data-cell-column='0']")).toBe(cell);
    const align = view.dom.querySelector<HTMLButtonElement>('[aria-label="Align right"]')!;
    fireEvent.click(align);
    expect(view.state.doc.toString()).toContain("| ---: | --- |");
  });
  it("defers table IME source updates until composition end", () => {
    const source = "# Table\n\n| A | B |\n| --- | --- |\n| c | d |\n";
    const view = editor(source, [liveMarkdown(context, false)]);
    const cell = view.dom.querySelector<HTMLElement>("[data-cell-row='1'][data-cell-column='0']")!;
    fireEvent.compositionStart(cell); cell.textContent = "中文"; fireEvent.input(cell);
    expect(view.state.doc.toString()).toBe(source);
    fireEvent.compositionEnd(cell);
    expect(view.state.doc.toString()).toContain("| 中文 | d |");
  });
  it("honors readonly table/source commands and does not write private image syntax", () => {
    const source = "# Table\n\n| A | B |\n| --- | --- |\n| c | d |\n";
    const view = editor(source, [EditorState.readOnly.of(true), liveMarkdown({ ...context, readOnly: true }, false)]);
    expect(view.dom.querySelector("[data-cell-row='1']")?.getAttribute("contenteditable")).toBe("false");
    expect(formatMarkdown(view, "bold")).toBe(false); setMarkdownHeading(view, 2);
    expect(view.state.doc.toString()).toBe(source);
  });
});

describe("clipboard conversion, async ownership and formatting", () => {
  it("Undo once restores original TSV, then removes the paste", () => {
    const view = editor("", [input()]);
    paste(view, "A\tB\nx\ty");
    expect(view.state.doc.toString()).toBe("| A | B |\n| --- | --- |\n| x | y |\n");
    expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe("A\tB\nx\ty");
    expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe("");
  });
  it("maps async image insertion through edits made while saving", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof saveMarkdownImage>>) => void;
    vi.mocked(saveMarkdownImage).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = editor("before\n", [input()], 7);
    const task = insertMarkdownImages(view, [new Blob(["image"], { type: "image/png" })]);
    view.dispatch({ changes: { from: 0, insert: "prefix\n" } });
    resolve({ path: "/docs/assets/img.png", relativePath: "assets/img.png", markdown: "![image](assets/img.png)" });
    await task;
    expect(view.state.doc.toString()).toBe("prefix\nbefore\n![image](assets/img.png)\n");
  });
  it("ignores image results after editor teardown and leaves no dangling source", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof saveMarkdownImage>>) => void;
    vi.mocked(saveMarkdownImage).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = editor("before", [input()]);
    const task = insertMarkdownImages(view, [new Blob(["image"], { type: "image/png" })]);
    view.destroy(); editors.splice(editors.indexOf(view), 1);
    resolve({ path: "/docs/assets/img.png", relativePath: "assets/img.png", markdown: "![image](assets/img.png)" });
    await task;
    expect(onError).not.toHaveBeenCalled(); expect(view.state.doc.toString()).toBe("before");
  });
  it("reports disk failures without inserting an image and formats selected text undoably", async () => {
    vi.mocked(saveMarkdownImage).mockRejectedValue(new Error("disk full"));
    const view = editor("hello", [input()]);
    await insertMarkdownImages(view, [new Blob(["image"], { type: "image/png" })]);
    expect(onError).toHaveBeenCalledWith("disk full"); expect(view.state.doc.toString()).toBe("hello");
    view.dispatch({ selection: { anchor: 0, head: 5 } }); formatMarkdown(view, "bold");
    expect(view.state.doc.toString()).toBe("**hello**");
    undo(view); expect(view.state.doc.toString()).toBe("hello");
  });
});
