import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildNotepadExtensions, createNotepadCompartments } from "./extensions";
import { buildRectangularSelection } from "./columnSelection";
import { setMarkHighlightsEffect } from "./marksAndTokens";
// @ts-expect-error Node builtin is confined to unit tests, not the DOM application.
import { readFileSync } from "node:fs";

const themeCss = readFileSync("src/styles/theme.css", "utf8") as string;
const notepadCss = readFileSync("src/components/notepad/notepad.css", "utf8") as string;

type Rgba = [number, number, number, number];
type Rgb = [number, number, number];

let styleEl: HTMLStyleElement;
let host: HTMLDivElement;
let view: EditorView | null = null;

function parseCssColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const raw = hex[1];
    return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16), 1];
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/i.exec(value.trim());
  if (!rgba) throw new Error(`Unsupported color format: ${value}`);
  return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
}

function compositeOver(fg: Rgba, bg: Rgb): Rgb {
  return [
    Math.round(fg[0] * fg[3] + bg[0] * (1 - fg[3])),
    Math.round(fg[1] * fg[3] + bg[1] * (1 - fg[3])),
    Math.round(fg[2] * fg[3] + bg[2] * (1 - fg[3])),
  ];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function normalizeColor(value: string): string {
  return value.replace(/\s+/g, "");
}

function resolveColorVar(el: Element, value: string): string {
  const style = getComputedStyle(el);
  let current = value.trim();
  for (let depth = 0; depth < 6; depth += 1) {
    const match = /^var\(\s*(--[^,\s)]+)(?:\s*,\s*(.+))?\)$/.exec(current);
    if (!match) return normalizeColor(current);
    const resolved = style.getPropertyValue(match[1]).trim();
    current = resolved || (match[2] ?? "").trim();
  }
  return normalizeColor(current);
}

function cssVariable(el: Element, name: string): string {
  return resolveColorVar(el, getComputedStyle(el).getPropertyValue(name));
}

function mountView(doc = "first line\nsecond line\nthird line"): EditorView {
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: buildNotepadExtensions({
        compartments: createNotepadCompartments(),
        readOnly: false,
        wrap: false,
        showLineNumbers: true,
        fontSizePx: 13,
        symbols: { space: false, tab: false, eol: false, nonprint: false, indent: false, wrap: false, eolLabel: "LF", showRuler: true, rulerCol: 80, tabSize: 4 },
        bookmarks: [],
        baselineLines: doc.split("\n"),
        showChangeHistory: true,
        marks: [],
      }),
    }),
    parent: host,
  });
  return view;
}

/** jsdom has no layout, so CM never paints RectangleMarker children. Mount a
 * synthetic background inside the real drawSelection layer to exercise the live
 * cascade against CodeMirror's baseTheme defaults. */
function selectionMarker(editor: EditorView): HTMLElement {
  const layer = editor.dom.querySelector<HTMLElement>(".cm-selectionLayer")!;
  expect(layer).not.toBeNull();
  const marker = document.createElement("div");
  marker.className = "cm-selectionBackground";
  layer.append(marker);
  return marker;
}

function setAppTheme(theme: "light" | "dark"): void {
  if (theme === "dark") document.documentElement.setAttribute("data-app-theme", "dark");
  else document.documentElement.removeAttribute("data-app-theme");
}

beforeEach(() => {
  styleEl = document.createElement("style");
  styleEl.textContent = `${themeCss}\n${notepadCss}`;
  document.head.append(styleEl);
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  view?.destroy();
  view = null;
  host.remove();
  styleEl.remove();
  document.documentElement.removeAttribute("data-app-theme");
});

describe("notepad selection theme (matches the Markdown source editor)", () => {
  it("declares the shared editor selection tokens in the notepad theme extension", () => {
    mountView();
    const cssText = Array.from(document.head.querySelectorAll("style"))
      .map((style) => style.textContent ?? "").join("\n");
    expect(cssText).toContain(".cm-selectionBackground");
    expect(cssText).toContain("--taomni-editor-selection-bg");
    expect(cssText).toContain("--taomni-editor-selection-unfocused-bg");
    expect(cssText).toContain("np-selection-active");
  });

  it.each(["light", "dark"] as const)("uses the readable %s app token for focused and unfocused selections", (appTheme) => {
    setAppTheme(appTheme);
    const editor = mountView();
    const marker = selectionMarker(editor);
    const expected = appTheme === "dark"
      ? { focused: "rgba(92,143,214,0.4)", unfocused: "rgba(92,143,214,0.22)" }
      : { focused: "rgba(37,99,235,0.26)", unfocused: "rgba(37,99,235,0.14)" };

    // Unfocused must beat CodeMirror's &light default #d9d9d9 (unreadable on a
    // dark notepad canvas because the text token is light).
    editor.dom.classList.remove("cm-focused");
    const unfocusedBg = resolveColorVar(marker, getComputedStyle(marker).backgroundColor);
    expect(unfocusedBg).not.toBe("rgb(217,217,217)");
    expect(unfocusedBg).toBe(expected.unfocused);

    // Focused must beat CodeMirror's &light.cm-focused default #d7d4f0.
    editor.dom.classList.add("cm-focused");
    const focusedBg = resolveColorVar(marker, getComputedStyle(marker).backgroundColor);
    expect(focusedBg).not.toBe("rgb(215,212,240)");
    expect(focusedBg).toBe(expected.focused);
  });

  it.each(["light", "dark"] as const)("keeps selected text at WCAG AA contrast in the %s app theme", (appTheme) => {
    setAppTheme(appTheme);
    const editor = mountView();
    const marker = selectionMarker(editor);
    editor.dom.classList.add("cm-focused");
    const canvas = parseCssColor(cssVariable(editor.dom, "--taomni-bg")).slice(0, 3) as Rgb;
    const text = parseCssColor(cssVariable(editor.dom, "--taomni-text")).slice(0, 3) as Rgb;
    const focused = parseCssColor(resolveColorVar(marker, getComputedStyle(marker).backgroundColor));
    editor.dom.classList.remove("cm-focused");
    const unfocused = parseCssColor(resolveColorVar(marker, getComputedStyle(marker).backgroundColor));
    expect(contrastRatio(text, compositeOver(focused, canvas))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(text, compositeOver(unfocused, canvas))).toBeGreaterThanOrEqual(4.5);
  });

  it("covers every rectangular multi-range with the focused token and suppresses the active-line occluder", () => {
    setAppTheme("dark");
    const editor = mountView();
    const marker = selectionMarker(editor);
    editor.dom.classList.add("cm-focused");

    // Three rectangular ranges (column selection) share the same selection layer.
    editor.dispatch({ selection: buildRectangularSelection(editor.state.doc, 1, 0, 3, 3) });
    expect(editor.state.selection.ranges).toHaveLength(3);
    expect(editor.dom).toHaveClass("np-selection-active");
    expect(resolveColorVar(marker, getComputedStyle(marker).backgroundColor)).toBe("rgba(92,143,214,0.4)");
    const activeLine = editor.contentDOM.querySelector<HTMLElement>(".cm-activeLine")!;
    expect(getComputedStyle(activeLine).backgroundColor).toBe("rgba(0, 0, 0, 0)");

    // Collapsing the selection restores the normal active line highlight.
    editor.dispatch({ selection: { anchor: 4 } });
    expect(editor.dom).not.toHaveClass("np-selection-active");
    expect(getComputedStyle(activeLine).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("keeps find-match highlights amber and distinguishable from the blue selection fill", () => {
    setAppTheme("dark");
    const editor = mountView("alpha target beta target gamma");
    const marker = selectionMarker(editor);
    editor.dom.classList.add("cm-focused");
    editor.dispatch({
      effects: setMarkHighlightsEffect.of({
        rules: [],
        activeMatch: { from: 6, to: 12 },
        findHighlight: { query: "target", mode: "normal", caseSensitive: false, wholeWord: false, dotAll: false },
      }),
    });
    const matches = Array.from(editor.contentDOM.querySelectorAll<HTMLElement>(".np-search-all-match"));
    expect(matches.length).toBeGreaterThan(0);
    const activeMatch = editor.contentDOM.querySelector<HTMLElement>(".np-search-active-match")!;
    const matchBg = parseCssColor(resolveColorVar(matches[0], getComputedStyle(matches[0]).backgroundColor));
    const activeBg = parseCssColor(resolveColorVar(activeMatch, getComputedStyle(activeMatch).backgroundColor));
    // Amber tokens (red > blue) stay warm against the cool blue selection fill.
    expect(matchBg[0]).toBeGreaterThan(matchBg[2]);
    expect(activeBg[0]).toBeGreaterThan(activeBg[2]);
    const selectionBg = parseCssColor(resolveColorVar(marker, getComputedStyle(marker).backgroundColor));
    expect(selectionBg[2]).toBeGreaterThan(selectionBg[0]);
    // The active match keeps the shared amber border token in the stylesheet.
    expect(notepadCss).toContain("--taomni-editor-selection-match-border");
  });
});
