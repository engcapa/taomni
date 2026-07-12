import { describe, expect, it } from "vitest";
import { inferTerminalProgram } from "./terminalActivity";

describe("inferTerminalProgram", () => {
  it("returns only the executable basename", () => {
    expect(inferTerminalProgram("python /tmp/app.py --token secret")).toBe("python");
    expect(inferTerminalProgram("/usr/local/bin/vite --host 0.0.0.0")).toBe("vite");
    expect(inferTerminalProgram('"C:\\Program Files\\Git\\bin\\bash.exe" -l')).toBe("bash");
  });

  it("skips common wrappers, options, and environment assignments", () => {
    expect(inferTerminalProgram("NODE_ENV=prod sudo -u deploy npm run start")).toBe("npm");
    expect(inferTerminalProgram("env -u DEBUG FOO=bar nohup ./server --key secret")).toBe("server");
    expect(inferTerminalProgram("time -f %E cargo test")).toBe("cargo");
  });

  it("uses the first command in a pipeline or compound line", () => {
    expect(inferTerminalProgram("rg TODO | head")).toBe("rg");
    expect(inferTerminalProgram("git status && echo done")).toBe("git");
  });

  it("handles PowerShell's call operator and empty input", () => {
    expect(inferTerminalProgram('& "C:\\Tools\\worker.exe" --secret value')).toBe("worker");
    expect(inferTerminalProgram("   ")).toBeNull();
  });
});
