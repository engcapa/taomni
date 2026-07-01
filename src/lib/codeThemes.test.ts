import { describe, expect, it } from "vitest";
import {
  CODE_THEME_COLOR_VARS,
  SYSTEM_DARK_CODE_THEME,
  SYSTEM_LIGHT_CODE_THEME,
  codeThemeVariablesFromPalette,
  getCodeThemeDefinition,
  isCodeThemeId,
  resolveSystemCodeThemeId,
} from "./codeThemes";
import { resolveCodeThemeVars, type CodeViewProfile } from "./codeViewProfile";

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

  it("resolves the system theme id from the resolved app theme", () => {
    expect(resolveSystemCodeThemeId("dark")).toBe("dracula");
    expect(resolveSystemCodeThemeId("light")).toBe("github-light");
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
  it("maps the system theme to dracula in dark and github-light in light", () => {
    expect(resolveCodeThemeVars(baseProfile, { resolvedAppTheme: "dark" })?.["--taomni-code-bg"]).toBe("#282a36");
    expect(resolveCodeThemeVars(baseProfile, { resolvedAppTheme: "light" })?.["--taomni-code-bg"]).toBe("#ffffff");
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
});
