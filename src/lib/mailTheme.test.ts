import { describe, expect, it } from "vitest";
import {
  mailCodeThemeValue,
  normalizeMailThemeSelectValue,
  resolveMailTheme,
} from "./mailTheme";

describe("mailTheme", () => {
  it("resolves prefixed code view themes", () => {
    const theme = resolveMailTheme(mailCodeThemeValue("dracula"), true);

    expect(theme.background).toBe("#282a36");
    expect(theme.foreground).toBe("#f8f8f2");
    expect(theme.blue).toBe("#8be9fd");
  });

  it("keeps direct terminal ids preferred for duplicate names", () => {
    const direct = resolveMailTheme("night-owl", true);
    const code = resolveMailTheme(mailCodeThemeValue("night-owl"), true);

    expect(direct.background).toBe("#011627");
    expect(direct.green).toBe("#22da6e");
    expect(code.background).toBe("#011627");
    expect(code.green).toBe("#22da6e");
    expect(code.yellow).not.toBe(direct.yellow);
  });

  it("normalizes legacy direct code ids to select values", () => {
    expect(normalizeMailThemeSelectValue("dracula")).toBe(mailCodeThemeValue("dracula"));
    expect(normalizeMailThemeSelectValue("termius-dark")).toBe("termius-dark");
  });
});
