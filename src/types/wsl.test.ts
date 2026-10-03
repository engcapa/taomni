import { describe, expect, it } from "vitest";
import {
  DEFAULT_WSL_OPTIONS,
  buildWslLaunchArgs,
  parseWslOptions,
  serializeWslOptions,
  type WslOptions,
} from "./wsl";

describe("buildWslLaunchArgs", () => {
  it("emits just -d for distro-only", () => {
    expect(buildWslLaunchArgs({ distro: "Ubuntu" })).toEqual(["-d", "Ubuntu"]);
  });

  it("appends -u when user is set", () => {
    expect(buildWslLaunchArgs({ distro: "Ubuntu", user: "ada" })).toEqual([
      "-d",
      "Ubuntu",
      "-u",
      "ada",
    ]);
  });

  it("appends --cd for Linux paths", () => {
    expect(buildWslLaunchArgs({ distro: "Ubuntu", cwd: "/home/ada/work" })).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/ada/work",
    ]);
  });

  it("appends --cd verbatim for Windows paths", () => {
    expect(
      buildWslLaunchArgs({ distro: "Ubuntu", cwd: "C:\\Users\\ada" }),
    ).toEqual(["-d", "Ubuntu", "--cd", "C:\\Users\\ada"]);
  });

  it("uses -- /bin/sh -lc form for initialCommand", () => {
    const args = buildWslLaunchArgs({
      distro: "Ubuntu",
      initialCommand: "tmux a",
    });
    expect(args).toEqual([
      "-d",
      "Ubuntu",
      "--",
      "/bin/sh",
      "-lc",
      "tmux a; exec $SHELL -l",
    ]);
  });

  it("composes all fields in the right order", () => {
    const args = buildWslLaunchArgs({
      distro: "Ubuntu",
      user: "ada",
      cwd: "~",
      initialCommand: "echo hi",
    });
    expect(args).toEqual([
      "-d",
      "Ubuntu",
      "-u",
      "ada",
      "--cd",
      "~",
      "--",
      "/bin/sh",
      "-lc",
      "echo hi; exec $SHELL -l",
    ]);
  });

  it("returns [] when distro is empty", () => {
    expect(buildWslLaunchArgs({ distro: "" })).toEqual([]);
    expect(buildWslLaunchArgs({ distro: "   " })).toEqual([]);
  });

  it("trims whitespace before composing", () => {
    expect(
      buildWslLaunchArgs({ distro: "  Ubuntu  ", user: "  ada  " }),
    ).toEqual(["-d", "Ubuntu", "-u", "ada"]);
  });
});

describe("parseWslOptions", () => {
  it("returns defaults for empty input", () => {
    expect(parseWslOptions(null)).toEqual(DEFAULT_WSL_OPTIONS);
    expect(parseWslOptions(undefined)).toEqual(DEFAULT_WSL_OPTIONS);
    expect(parseWslOptions("")).toEqual(DEFAULT_WSL_OPTIONS);
  });

  it("returns defaults for malformed JSON", () => {
    expect(parseWslOptions("not json")).toEqual(DEFAULT_WSL_OPTIONS);
  });

  it("reads structured wsl* keys", () => {
    const json = JSON.stringify({
      wslDistro: "Ubuntu",
      wslUser: "ada",
      wslCwd: "/home/ada",
      wslInitialCommand: "tmux a",
      wslAsAdministrator: true,
    });
    expect(parseWslOptions(json)).toEqual({
      distro: "Ubuntu",
      user: "ada",
      cwd: "/home/ada",
      initialCommand: "tmux a",
      asAdministrator: true,
    });
  });

  it("derives distro from legacy localShellArgs (no wsl* keys)", () => {
    const json = JSON.stringify({
      localShellPath: "wsl.exe",
      localShellArgs: ["-d", "Ubuntu"],
      description: "Imported from WSL",
    });
    expect(parseWslOptions(json)).toEqual({ distro: "Ubuntu" });
  });

  it("ignores localShellPath when not wsl.exe", () => {
    const json = JSON.stringify({
      localShellPath: "/bin/bash",
      localShellArgs: ["-d", "noisy-arg"],
    });
    expect(parseWslOptions(json)).toEqual({ distro: "" });
  });

  it("prefers wslDistro over localShellArgs derivation", () => {
    const json = JSON.stringify({
      wslDistro: "Debian",
      localShellPath: "wsl.exe",
      localShellArgs: ["-d", "Ubuntu"],
    });
    expect(parseWslOptions(json).distro).toBe("Debian");
  });
});

describe("serializeWslOptions", () => {
  it("emits only wslDistro for minimal options", () => {
    expect(serializeWslOptions({ distro: "Ubuntu" })).toEqual({
      wslDistro: "Ubuntu",
    });
  });

  it("emits all populated keys", () => {
    const opts: WslOptions = {
      distro: "Ubuntu",
      user: "ada",
      cwd: "/work",
      initialCommand: "tmux",
      asAdministrator: true,
    };
    expect(serializeWslOptions(opts)).toEqual({
      wslDistro: "Ubuntu",
      wslUser: "ada",
      wslCwd: "/work",
      wslInitialCommand: "tmux",
      wslAsAdministrator: true,
    });
  });

  it("round-trips through parseWslOptions identically", () => {
    const opts: WslOptions = {
      distro: "Ubuntu",
      user: "ada",
      cwd: "~",
      initialCommand: "echo hi",
    };
    const json = JSON.stringify(serializeWslOptions(opts));
    expect(parseWslOptions(json)).toEqual(opts);
  });
});
