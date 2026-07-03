import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_PROFILE,
  loadLocalTerminalDefaultProfile,
  saveLocalTerminalDefaultProfile,
} from "./terminalProfile";

describe("local terminal default profile", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults new local terminals to the system theme", () => {
    expect(loadLocalTerminalDefaultProfile()).toMatchObject({
      theme: "system",
    });
  });

  it("persists a local-terminal-only default profile", () => {
    saveLocalTerminalDefaultProfile({
      ...DEFAULT_TERMINAL_PROFILE,
      fontSize: 17,
      theme: "kanagawa-wave",
    });

    expect(loadLocalTerminalDefaultProfile()).toMatchObject({
      fontSize: 17,
      theme: "kanagawa-wave",
    });
    expect(window.localStorage.getItem("taomni.terminalProfile.v1")).toBeNull();
  });
});
