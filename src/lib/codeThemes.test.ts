import { describe, expect, it } from "vitest";
import {
  CODE_THEME_COLOR_VARS,
  SYSTEM_DARK_CODE_THEME,
  SYSTEM_LIGHT_CODE_THEME,
  codeThemeVariablesFromPalette,
  getCodeThemeDefinition,
  isCodeThemeId,
} from "./codeThemes";
import {
  CODE_VIEW_TERMINAL_THEME_PREFIX,
  resolveCodeThemeVars,
  type CodeViewProfile,
} from "./codeViewProfile";

const baseProfile: CodeViewProfile = {
  fontFamily: "monospace",
  fontSize: 13,
  fontLigatures: true,
  theme: "system",
};

describe("codeThemes registry", () => {
  it("ships the popular system defaults (dracula / github-light)", () => {
    expect(SYSTEM_DARK_CODE_THEME).toBe("dracula");
    expect(SYSTEM_LIGHT_CODE_THEME).toBe("github-light");
    expect(getCodeThemeDefinition("dracula")?.variant).toBe("dark");
    expect(getCodeThemeDefinition("github-light")?.variant).toBe("light");
  });

  it("expands a palette into the full variable set with the declared background", () => {
    const dracula = getCodeThemeDefinition("dracula")!;
    const vars = codeThemeVariablesFromPalette(dracula.palette);
    for (const name of CODE_THEME_COLOR_VARS) {
      expect(vars[name], `missing ${name}`).toBeTruthy();
    }
    expect(vars["--taomni-code-bg"]).toBe("#282a36");
    expect(vars["--taomni-code-syntax-keyword"]).toBe("#ff79c6");
  });

  it("recognises registry ids and rejects terminal ids", () => {
    expect(isCodeThemeId("monokai")).toBe(true);
    expect(isCodeThemeId("kanagawa-wave")).toBe(false);
  });
});

describe("resolveCodeThemeVars", () => {
  it("treats the legacy system theme as app-following", () => {
    expect(resolveCodeThemeVars(baseProfile, { resolvedAppTheme: "dark" })).toBeNull();
    expect(resolveCodeThemeVars(baseProfile, { resolvedAppTheme: "light" })).toBeNull();
  });

  it("resolves an explicit editor theme id", () => {
    const vars = resolveCodeThemeVars({ ...baseProfile, theme: "monokai" }, { resolvedAppTheme: "dark" });
    expect(vars?.["--taomni-code-bg"]).toBe("#272822");
  });

  it("returns null for the app theme so index.css defaults apply", () => {
    expect(resolveCodeThemeVars({ ...baseProfile, theme: "app" }, { resolvedAppTheme: "dark" })).toBeNull();
  });

  it("keeps back-compat with saved terminal-theme ids", () => {
    const vars = resolveCodeThemeVars({ ...baseProfile, theme: "kanagawa-wave" }, { resolvedAppTheme: "dark" });
    expect(vars?.["--taomni-code-bg"]).toBe("#1f1f28");
  });

  it("resolves explicit prefixed terminal-theme ids", () => {
    const vars = resolveCodeThemeVars(
      { ...baseProfile, theme: `${CODE_VIEW_TERMINAL_THEME_PREFIX}night-owl` },
      { resolvedAppTheme: "dark" },
    );
    expect(vars?.["--taomni-code-bg"]).toBe("#011627");
  });
});
