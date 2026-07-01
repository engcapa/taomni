import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTES_THEMES, notesThemeDensity, notesThemeStyle, resolveSystemTheme } from "./notesTheme";

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
    expect(light["--taomni-bg"]).toBe("#ffffff");
    expect(dark["--taomni-bg"]).toBe("#0f172a");
    expect(paper["--taomni-bg"]).toBe("#fdf6e3");
    // Every palette must define text + background so nothing is unreadable.
    for (const p of [light, dark, paper]) {
      expect(p["--taomni-text"]).toBeTruthy();
      expect(p["--taomni-bg"]).toBeTruthy();
    }
  });

  it("resolves the system theme from prefers-color-scheme", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("dark"), media: q }));
    expect(resolveSystemTheme()).toBe("dark");
    const style = notesThemeStyle("system") as Record<string, string>;
    expect(style["--taomni-bg"]).toBe("#0f172a");
  });

  it("marks only the compact theme as compact density", () => {
    expect(notesThemeDensity("compact")).toBe("compact");
    expect(notesThemeDensity("taomni")).toBe("comfortable");
    expect(notesThemeDensity("dark")).toBe("comfortable");
  });

  it("exposes exactly the six planned themes", () => {
    expect(NOTES_THEMES).toEqual(["taomni", "system", "light", "dark", "paper", "compact"]);
  });
});
