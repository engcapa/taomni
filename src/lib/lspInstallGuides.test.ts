import { describe, expect, it } from "vitest";
import {
  detectHostOs,
  resolveInstallGuide,
  installGuideForCommandId,
} from "./lspInstallGuides";

describe("resolveInstallGuide", () => {
  it("returns a single shared line for cross-platform tools", () => {
    const guide = resolveInstallGuide("rust-analyzer");
    expect(guide?.multiOs).toBe(false);
    expect(guide?.lines).toHaveLength(1);
    expect(guide?.lines[0].os).toBeNull();
    expect(guide?.lines[0].command).toContain("rustup component add rust-analyzer");
  });

  it("splits jdtls by OS with real download URLs and install notes", () => {
    const guide = resolveInstallGuide("jdtls");
    expect(guide?.multiOs).toBe(true);
    expect(guide?.lines.map((line) => line.os)).toEqual(["linux", "macos", "windows"]);
    const linux = guide?.lines.find((line) => line.os === "linux");
    const macos = guide?.lines.find((line) => line.os === "macos");
    const windows = guide?.lines.find((line) => line.os === "windows");
    expect(linux?.command).toContain(
      "https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz",
    );
    expect(linux?.command).toContain("config_linux");
    expect(linux?.note).toMatch(/JDK 17/i);
    expect(linux?.note).toMatch(/only lists folders|目录/i);
    expect(macos?.command).toContain("brew install jdtls");
    expect(windows?.command).toContain("config_win");
    expect(windows?.command).toContain("jdt-language-server-latest.tar.gz");
  });

  it("includes verify steps for npm / rustup / go tools", () => {
    expect(resolveInstallGuide("typescript-language-server")?.lines[0].command)
      .toContain("npm install -g typescript typescript-language-server");
    expect(resolveInstallGuide("rust-analyzer")?.lines[0].command)
      .toContain("rustup component add rust-analyzer");
    expect(resolveInstallGuide("gopls")?.lines[0].command)
      .toContain("go install golang.org/x/tools/gopls@latest");
    expect(resolveInstallGuide("pyright")?.lines[0].command)
      .toContain("pyright-langserver");
  });

  it("falls back to the backend install hint when catalog has no entry", () => {
    const guide = resolveInstallGuide("unknown-ls", "curl -fsSL example.com | sh");
    expect(guide?.multiOs).toBe(false);
    expect(guide?.lines[0].command).toBe("curl -fsSL example.com | sh");
  });

  it("returns null when neither catalog nor backend hint exists", () => {
    expect(resolveInstallGuide("unknown-ls")).toBeNull();
    expect(resolveInstallGuide("unknown-ls", "  ")).toBeNull();
  });
});

describe("installGuideForCommandId", () => {
  it("covers primary language-server command ids", () => {
    for (const id of [
      "typescript-language-server",
      "rust-analyzer",
      "pyright",
      "gopls",
      "jdtls",
      "clangd",
      "csharp-ls",
    ]) {
      expect(installGuideForCommandId(id), id).not.toBeNull();
    }
  });
});

describe("detectHostOs", () => {
  it("returns a known OS or null", () => {
    const os = detectHostOs();
    expect(os === null || os === "linux" || os === "macos" || os === "windows").toBe(true);
  });
});
