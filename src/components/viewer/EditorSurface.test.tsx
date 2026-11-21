import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorSurface } from "./EditorSurface";
import { useDocumentStore } from "../../stores/documentStore";
import { viewerReadText, viewerStat } from "../../lib/viewer";
// @ts-expect-error Node builtin is confined to unit tests, not the DOM application.
import { readFileSync } from "node:fs";

const themeCss = readFileSync("src/styles/theme.css", "utf8") as string;
const viewerCss = readFileSync("src/components/viewer/viewer.css", "utf8") as string;

vi.mock("../../lib/viewer", async (original) => ({ ...await original<typeof import("../../lib/viewer")>(), viewerStat: vi.fn(), viewerReadText: vi.fn() }));
const path = "/note.txt";
let styleEl: HTMLStyleElement;

function parseCssColor(value: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const raw = hex[1];
    return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16), 1];
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/i.exec(value.trim());
  if (!rgba) throw new Error(`Unsupported color format: ${value}`);
  return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
}

function compositeOver(fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] {
  const alpha = fg[3];
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function normalizeColor(value: string): string {
  return value.replace(/\s+/g, "");
}

function resolveColorVar(el: Element, value: string): string {
  const style = getComputedStyle(el);
  let current = value.trim();
  for (let depth = 0; depth < 6; depth++) {
    const match = /^var\(\s*(--[^,\s)]+)(?:\s*,\s*(.+))?\)$/.exec(current);
    if (!match) return normalizeColor(current);
    const resolved = style.getPropertyValue(match[1]).trim();
    current = resolved || (match[2] ?? "").trim();
  }
  return normalizeColor(current);
}

beforeEach(async () => {
  localStorage.clear(); useDocumentStore.setState({ documents: {} });
  document.documentElement.removeAttribute("data-app-theme");
  styleEl = document.createElement("style");
  styleEl.textContent = `${themeCss}\n${viewerCss}`;
  document.head.append(styleEl);
  vi.mocked(viewerStat).mockResolvedValue({ path, size: 3, mtime: 1, mime: "text/plain", isFile: true });
  vi.mocked(viewerReadText).mockResolvedValue({ path, content: "old", hash: "h", encoding: "UTF-8", bom: false, eol: "LF", mtime: 1, size: 3, truncated: false });
  await useDocumentStore.getState().open(path);
});
afterEach(() => {
  cleanup();
  styleEl.remove();
  document.documentElement.removeAttribute("data-app-theme");
});

describe("lightweight shared CodeMirror surface", () => {
  it("keeps one mounted view and sends only local changes into the shared store", async () => {
    let view: EditorView | null = null;
    const current = () => useDocumentStore.getState().documents[path];
    const screen = render(<div className="fv"><EditorSurface document={current()} onView={(value) => { view = value; }} /></div>);
    await waitFor(() => expect(view).not.toBeNull());
    const original = view;
    act(() => { view!.dispatch({ changes: { from: 0, to: 3, insert: "mine" } }); });
    expect(current().content).toBe("mine"); expect(current().dirty).toBe(true);
    screen.rerender(<div className="fv"><EditorSurface document={{ ...current(), content: "shared" }} onView={(value) => { view = value; }} /></div>);
    expect(view).toBe(original); expect(view!.state.doc.toString()).toBe("shared");
    expect(current().content).toBe("mine");
  });
  it("publishes actual line and column changes without recreating the view", async () => {
    let view: EditorView | null = null;
    const cursor = vi.fn();
    const current = useDocumentStore.getState().documents[path];
    render(<div className="fv"><EditorSurface document={current} onView={(value) => { view = value; }} onCursorChange={cursor} /></div>);
    await waitFor(() => expect(view).not.toBeNull());
    act(() => view!.dispatch({ changes: { from: 0, to: 3, insert: "one\ntwo" }, selection: { anchor: 6 } }));
    expect(cursor).toHaveBeenLastCalledWith({ line: 2, column: 3 });
  });
  it("makes remote and large documents non-editable", async () => {
    const current = useDocumentStore.getState().documents[path];
    const screen = render(<div className="fv"><EditorSurface document={{ ...current, readOnly: true }} /></div>);
    await waitFor(() => expect(screen.getByTestId("viewer-editor-content")).toHaveAttribute("contenteditable", "false"));
  });

  it.each(["dark", "light"] as const)("overrides CodeMirror baseTheme selection fill with readable %s tokens for focused and unfocused ranges", async (appTheme) => {
    if (appTheme === "dark") document.documentElement.setAttribute("data-app-theme", "dark");
    let view: EditorView | null = null;
    const current = useDocumentStore.getState().documents[path];
    const screen = render(<div className="fv"><EditorSurface document={{ ...current, content: "first line\nsecond line\nthird line" }} onView={(value) => { view = value; }} /></div>);
    await waitFor(() => expect(view).not.toBeNull());

    const cmEditor = screen.getByTestId("viewer-editor").querySelector<HTMLElement>(".cm-editor")!;
    const selectionLayer = cmEditor.querySelector<HTMLElement>(".cm-selectionLayer")!;
    expect(selectionLayer).not.toBeNull();
    // jsdom has zero box geometry so CM does not paint RectangleMarker children;
    // mount a synthetic .cm-selectionBackground inside the real .cm-selectionLayer
    // to exercise the exact live CSS cascade against CodeMirror's baseTheme.
    const marker = document.createElement("div");
    marker.className = "cm-selectionBackground";
    selectionLayer.append(marker);

    // Unfocused selection must beat CM's default #d9d9d9
    cmEditor.classList.remove("cm-focused");
    const unfocusedBg = resolveColorVar(marker, getComputedStyle(marker).backgroundColor);
    expect(unfocusedBg.toLowerCase()).not.toBe("#d9d9d9");
    expect(unfocusedBg).not.toBe("rgb(217,217,217)");
    expect(unfocusedBg).toBe(appTheme === "dark" ? "rgba(92,143,214,0.22)" : "rgba(37,99,235,0.14)");

    // Focused selection must beat CM's &light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground (#d7d4f0)
    cmEditor.classList.add("cm-focused");
    const focusedBg = resolveColorVar(marker, getComputedStyle(marker).backgroundColor);
    expect(focusedBg.toLowerCase()).not.toBe("#d7d4f0");
    expect(focusedBg).not.toBe("rgb(215,212,240)");
    expect(focusedBg).toBe(appTheme === "dark" ? "rgba(92,143,214,0.4)" : "rgba(37,99,235,0.26)");

    // Check WCAG AA (>= 4.5:1) contrast of editor text on top of focused & unfocused selection composited over editor canvas
    const canvasRgb = parseCssColor(resolveColorVar(cmEditor, getComputedStyle(cmEditor).getPropertyValue("--bg"))).slice(0, 3) as [number, number, number];
    const textRgb = parseCssColor(resolveColorVar(cmEditor, getComputedStyle(cmEditor).getPropertyValue("--text"))).slice(0, 3) as [number, number, number];
    const focusedComposite = compositeOver(parseCssColor(focusedBg), canvasRgb);
    const unfocusedComposite = compositeOver(parseCssColor(unfocusedBg), canvasRgb);
    expect(contrastRatio(textRgb, focusedComposite)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(textRgb, unfocusedComposite)).toBeGreaterThanOrEqual(4.5);
  });

  it("suppresses active-line occlusion while selecting and restores it on collapse without requiring markdown.css", async () => {
    document.documentElement.setAttribute("data-app-theme", "dark");
    let view: EditorView | null = null;
    const current = useDocumentStore.getState().documents[path];
    const screen = render(<div className="fv"><EditorSurface document={{ ...current, content: "alpha\nbeta\ngamma" }} onView={(value) => { view = value; }} /></div>);
    await waitFor(() => expect(view).not.toBeNull());
    const host = screen.getByTestId("viewer-editor");
    const activeLine = () => view!.contentDOM.querySelector<HTMLElement>(".cm-activeLine")!;

    expect(host).not.toHaveClass("fv-selection-active");
    expect(getComputedStyle(activeLine()).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    act(() => view!.dispatch({ selection: { anchor: 0, head: 10 } }));
    expect(host).toHaveClass("fv-selection-active");
    expect(getComputedStyle(activeLine()).backgroundColor).toBe("rgba(0, 0, 0, 0)");

    act(() => view!.dispatch({ selection: { anchor: 10 } }));
    expect(host).not.toHaveClass("fv-selection-active");
    expect(getComputedStyle(activeLine()).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("styles selection matches with theme tokens and keeps main match transparent over selection", async () => {
    document.documentElement.setAttribute("data-app-theme", "dark");
    let view: EditorView | null = null;
    const current = useDocumentStore.getState().documents[path];
    render(<div className="fv"><EditorSurface document={{ ...current, content: "Mermaid docs and Mermaid render" }} onView={(value) => { view = value; }} /></div>);
    await waitFor(() => expect(view).not.toBeNull());

    act(() => view!.dispatch({ selection: { anchor: 0, head: 7 } }));
    const matches = Array.from(view!.contentDOM.querySelectorAll<HTMLElement>(".cm-selectionMatch"));
    expect(matches).toHaveLength(1);
    expect(matches[0].textContent).toBe("Mermaid");
    const matchBg = resolveColorVar(matches[0], getComputedStyle(matches[0]).backgroundColor);
    expect(matchBg).not.toBe("#99ff7780");
    expect(matchBg).toBe("rgba(225,177,75,0.3)");
  });

  it("toggles CodeMirror drawSelection layer cleanly when nativeSelection changes", async () => {
    const current = useDocumentStore.getState().documents[path];
    const screen = render(<div className="fv"><EditorSurface document={current} nativeSelection={true} /></div>);
    await waitFor(() => expect(screen.getByTestId("viewer-editor").querySelector(".cm-editor")).not.toBeNull());
    expect(screen.getByTestId("viewer-editor").querySelector(".cm-selectionLayer")).toBeNull();

    screen.rerender(<div className="fv"><EditorSurface document={current} nativeSelection={false} /></div>);
    await waitFor(() => expect(screen.getByTestId("viewer-editor").querySelector(".cm-selectionLayer")).not.toBeNull());
  });
});
