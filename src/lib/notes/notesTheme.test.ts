import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTES_FONTS, NOTES_THEMES, notesFontSizeStyle, notesFontStyle, notesThemeDensity, notesThemeStyle } from "./notesTheme";

describe("notesTheme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("inherits the app theme for taomni (no overrides)", () => {
    expect(notesThemeStyle("taomni")).toEqual({});
    expect(notesThemeStyle("compact")).toEqual({});
  });

  it("overrides CSS variables for explicit palettes", () => {
    const light = notesThemeStyle("light") as Record<string, string>;
    const dark = notesThemeStyle("dark") as Record<string, string>;
    const paper = notesThemeStyle("paper") as Record<string, string>;
    const sticky = notesThemeStyle("sticky") as Record<string, string>;
    const stickyBright = notesThemeStyle("sticky_bright") as Record<string, string>;
    const mint = notesThemeStyle("mint") as Record<string, string>;
    const sky = notesThemeStyle("sky") as Record<string, string>;
    const rose = notesThemeStyle("rose") as Record<string, string>;
    const graphite = notesThemeStyle("graphite") as Record<string, string>;
    expect(light["--taomni-bg"]).toBe("#ffffff");
    expect(dark["--taomni-bg"]).toBe("#0f172a");
    expect(paper["--taomni-bg"]).toBe("#fdf6e3");
    expect(sticky["--taomni-bg"]).toBe("#fff4a8");
    expect(stickyBright["--taomni-bg"]).toBe("#fbff8f");
    expect(mint["--taomni-bg"]).toBe("#edfdf6");
    expect(sky["--taomni-bg"]).toBe("#eff7ff");
    expect(rose["--taomni-bg"]).toBe("#fff1f5");
    expect(graphite["--taomni-bg"]).toBe("#202124");
    // The local theme must cover generic controls inside the Tao pane too.
    for (const p of [light, dark, paper, sticky, stickyBright, mint, sky, rose, graphite]) {
      expect(p["--taomni-text"]).toBeTruthy();
      expect(p["--taomni-bg"]).toBeTruthy();
      expect(p["--taomni-input-bg"]).toBeTruthy();
      expect(p["--taomni-input-border"]).toBeTruthy();
      expect(p["--taomni-button-from"]).toBeTruthy();
      expect(p["--taomni-card-bg"]).toBeTruthy();
      expect(p["--taomni-selected-border"]).toBeTruthy();
    }
  });

  it("marks only the compact theme as compact density", () => {
    expect(notesThemeDensity("compact")).toBe("compact");
    expect(notesThemeDensity("taomni")).toBe("comfortable");
    expect(notesThemeDensity("dark")).toBe("comfortable");
  });

  it("exposes app-following and explicit note themes", () => {
    expect(NOTES_THEMES).toEqual([
      "taomni",
      "light",
      "dark",
      "paper",
      "sticky",
      "sticky_bright",
      "mint",
      "sky",
      "rose",
      "graphite",
      "compact",
    ]);
  });

  it("exposes expanded font stacks and a local font-size variable", () => {
    expect(NOTES_FONTS).toEqual(["inherit", "system", "inter", "outfit", "rounded", "serif", "songti", "kaiti", "handwriting", "mono"]);
    expect(notesFontStyle("handwriting").fontFamily).toContain("Segoe Print");
    expect(notesFontSizeStyle(16)).toMatchObject({
      "--taomni-notes-font-size": "16px",
      "--taomni-ui-font-size": "16px",
    });
  });
});
