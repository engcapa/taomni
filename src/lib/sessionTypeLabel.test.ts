import { describe, expect, it } from "vitest";
import { isWslSessionOptions, sessionTypeLabel } from "./terminalProfile";

describe("sessionTypeLabel", () => {
  it("returns the raw type for non-LocalShell sessions", () => {
    expect(sessionTypeLabel("SSH", null)).toBe("SSH");
    expect(sessionTypeLabel("SFTP", JSON.stringify({ localShellPath: "wsl.exe" })))
      .toBe("SFTP");
  });

  it("returns 'WSL' when LocalShell points to wsl.exe", () => {
    expect(sessionTypeLabel("LocalShell", JSON.stringify({ localShellPath: "wsl.exe" })))
      .toBe("WSL");
    expect(sessionTypeLabel("LocalShell", JSON.stringify({ localShellPath: "C:\\Windows\\System32\\wsl.exe" })))
      .toBe("WSL");
  });

  it("returns 'LocalShell' for ordinary local shells", () => {
    expect(sessionTypeLabel("LocalShell", JSON.stringify({ localShellPath: "/bin/bash" })))
      .toBe("LocalShell");
    expect(sessionTypeLabel("LocalShell", null)).toBe("LocalShell");
    expect(sessionTypeLabel("LocalShell", "")).toBe("LocalShell");
  });

  it("handles invalid options JSON without throwing", () => {
    expect(sessionTypeLabel("LocalShell", "{not json")).toBe("LocalShell");
  });
});

describe("isWslSessionOptions", () => {
  it("detects wsl.exe regardless of casing or directory", () => {
    expect(isWslSessionOptions(JSON.stringify({ localShellPath: "wsl.exe" }))).toBe(true);
    expect(isWslSessionOptions(JSON.stringify({ localShellPath: "WSL.EXE" }))).toBe(true);
    expect(isWslSessionOptions(JSON.stringify({ localShellPath: "C:/Windows/System32/wsl.exe" }))).toBe(true);
  });

  it("returns false for other shells or missing options", () => {
    expect(isWslSessionOptions(JSON.stringify({ localShellPath: "/bin/zsh" }))).toBe(false);
    expect(isWslSessionOptions(null)).toBe(false);
    expect(isWslSessionOptions(undefined)).toBe(false);
    expect(isWslSessionOptions("")).toBe(false);
  });
});
