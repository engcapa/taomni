import { describe, expect, it } from "vitest";
import {
  parseLocalShellArgsText,
  parseLocalShellOptions,
  serializeLocalShellOptions,
  shellArgsToText,
} from "./localShell";

describe("local shell options", () => {
  it("parses and serializes local shell launch options", () => {
    const options = parseLocalShellOptions(JSON.stringify({
      localShellPath: "/bin/bash",
      localShellArgs: ["--login", "-i"],
    }));

    expect(options).toEqual({
      shellPath: "/bin/bash",
      shellArgsText: "--login -i",
    });
    expect(serializeLocalShellOptions(options)).toEqual({
      localShellPath: "/bin/bash",
      localShellArgs: ["--login", "-i"],
    });
  });

  it("omits shell keys when the default shell is selected", () => {
    expect(serializeLocalShellOptions({ shellPath: "", shellArgsText: "--login" })).toEqual({});
  });

  it("parses quoted argv text without treating Windows paths as escapes", () => {
    expect(parseLocalShellArgsText("--login \"two words\" C:\\Tools\\init.ps1")).toEqual([
      "--login",
      "two words",
      "C:\\Tools\\init.ps1",
    ]);
  });

  it("quotes argv values for editing", () => {
    expect(shellArgsToText(["--command", "echo hello", "C:\\Program Files\\app"])).toBe(
      "--command \"echo hello\" \"C:\\\\Program Files\\\\app\"",
    );
  });

  it("round-trips empty argv values", () => {
    expect(parseLocalShellArgsText(shellArgsToText(["--flag", ""]))).toEqual(["--flag", ""]);
  });
});
