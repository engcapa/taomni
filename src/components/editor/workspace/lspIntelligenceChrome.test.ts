import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  buildLspIntelligenceDecorations,
  fallbackWordHighlights,
} from "./lspIntelligenceChrome";

describe("LSP intelligence chrome", () => {
  it("creates weak same-word fallback highlights with Unicode boundaries", () => {
    const text = "const value = 1;\nreturn value + otherValue;";
    const highlights = fallbackWordHighlights(text, { line: 0, character: 8 });
    expect(highlights).toHaveLength(2);
    expect(highlights[0].range.start).toEqual({ line: 0, character: 6 });
    expect(highlights[1].range.start).toEqual({ line: 1, character: 7 });
    expect(highlights.every((item) => item.kind === null)).toBe(true);
  });

  it("builds read/write marks and inlay widgets", () => {
    const doc = EditorState.create({ doc: "const value = 1;" }).doc;
    const decorations = buildLspIntelligenceDecorations(
      doc,
      [
        {
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
          kind: 2,
        },
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          kind: 3,
        },
      ],
      [{
        position: { line: 0, character: 11 },
        label: ": number",
        kind: 1,
        tooltip: "inferred type",
        paddingLeft: true,
        paddingRight: false,
      }],
    );
    const classes: string[] = [];
    let widgets = 0;
    decorations.between(0, doc.length, (_from, _to, value) => {
      if (value.spec.class) classes.push(value.spec.class);
      if (value.spec.widget) widgets += 1;
    });
    expect(classes).toContain("cm-lsp-usage cm-lsp-usage-read");
    expect(classes).toContain("cm-lsp-usage cm-lsp-usage-write");
    expect(widgets).toBe(1);
  });
});
