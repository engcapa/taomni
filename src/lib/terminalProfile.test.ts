import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_PROFILE,
  loadTerminalDefaultProfile,
  saveTerminalDefaultProfile,
} from "./terminalProfile";
import { getDefaultTerminalFontName } from "./systemFonts";

describe("terminal default profile", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults new terminals to MobaXterm Classic with the platform terminal font", () => {
    expect(loadTerminalDefaultProfile()).toMatchObject({
      theme: "classic",
      fontFamily: expect.stringContaining(getDefaultTerminalFontName()),
    });
  });

  it("persists a global terminal default profile", () => {
    saveTerminalDefaultProfile({
      ...DEFAULT_TERMINAL_PROFILE,
      fontSize: 17,
      theme: "kanagawa-wave",
    });

    expect(loadTerminalDefaultProfile()).toMatchObject({
      fontSize: 17,
      theme: "kanagawa-wave",
    });
    expect(window.localStorage.getItem("taomni.terminalDefaultProfile.v1")).not.toBeNull();
    expect(window.localStorage.getItem("taomni.terminalProfile.v1")).toBeNull();
  });

  it("loads the legacy local terminal default profile key", () => {
    window.localStorage.setItem("taomni.localTerminalProfile.v1", JSON.stringify({
      ...DEFAULT_TERMINAL_PROFILE,
      fontSize: 18,
      theme: "termius-dark",
    }));

    expect(loadTerminalDefaultProfile()).toMatchObject({
      fontSize: 18,
      theme: "termius-dark",
    });
  });
});
