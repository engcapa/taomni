// @ts-expect-error Node builtins are used only to read the stylesheet source.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const notepadCss = readFileSync("src/components/notepad/notepad.css", "utf8");

/**
 * U1 regression guard: `.np-modal` and the rest of the Notepad chrome used
 * tokens that theme.css never defines, so dark mode fell back to a white
 * surface with light text. Only defined `--taomni-*` tokens may be used here.
 * (Computed dark/light styles are asserted by browser QA, not jsdom.)
 */
describe("Notepad theme tokens (U1)", () => {
  it("does not reference the undefined --taomni-surface token", () => {
    expect(notepadCss).not.toMatch(/var\(--taomni-surface[,)]/);
    expect(notepadCss).not.toContain("--taomni-surface");
  });

  it("does not reference the undefined --taomni-panel token (but keeps --taomni-panel-bg)", () => {
    expect(notepadCss).not.toMatch(/var\(--taomni-panel[,)]/);
    // A bare `--taomni-panel` token, not the defined `--taomni-panel-bg`/
    // `--taomni-panel-border` siblings.
    expect(notepadCss).not.toMatch(/--taomni-panel(?![\w-])/);
    expect(notepadCss).toContain("--taomni-panel-bg");
  });

  it("renders the Save As modal on the themed panel surface with readable text", () => {
    const modalBlock = notepadCss.match(/\.np-modal\s*\{[^}]*\}/)?.[0] ?? "";
    expect(modalBlock).toContain("background: var(--taomni-panel-bg, #ffffff)");
    expect(modalBlock).toContain("color: var(--taomni-text, #111827)");
  });
});
