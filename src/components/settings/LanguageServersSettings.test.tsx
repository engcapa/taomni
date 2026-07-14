import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageServersSettings } from "./LanguageServersSettings";

const writeTextMock = vi.fn(async (_text: string) => {});
const detectMock = vi.fn();

vi.mock("../../lib/clipboard", () => ({
  writeText: (text: string) => writeTextMock(text),
}));

vi.mock("../../lib/editor/lsp", () => ({
  lspDetectServers: () => detectMock(),
}));

vi.mock("../../lib/i18n", () => ({
  useT: () => (key: string, params?: Record<string, string | number>) => {
    if (params) return `${key}:${JSON.stringify(params)}`;
    return key;
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

beforeEach(() => {
  detectMock.mockResolvedValue([
    {
      presetId: "java",
      displayName: "Java",
      documentLanguageIds: ["java"],
      available: false,
      active: false,
      selectedCommandId: "jdtls",
      selectedCommand: null,
      installHint: "brew install jdtls  # JDK 17+",
      error: null,
      commands: [
        {
          id: "jdtls",
          label: "jdtls",
          command: "jdtls",
          args: [],
          installHint: "brew install jdtls  # JDK 17+",
          fallback: false,
          available: false,
        },
      ],
    },
    {
      presetId: "rust",
      displayName: "Rust",
      documentLanguageIds: ["rust"],
      available: true,
      active: false,
      selectedCommandId: "rust-analyzer",
      selectedCommand: "rust-analyzer",
      installHint: "rustup component add rust-analyzer",
      error: null,
      commands: [
        {
          id: "rust-analyzer",
          label: "rust-analyzer",
          command: "rust-analyzer",
          args: [],
          installHint: "rustup component add rust-analyzer",
          fallback: false,
          available: true,
        },
      ],
    },
  ]);
});

describe("LanguageServersSettings", () => {
  it("lists detected servers and shows install hints for missing ones", async () => {
    render(<LanguageServersSettings />);
    expect(await screen.findByTestId("language-server-row-java")).toBeInTheDocument();
    expect(screen.getByTestId("language-server-row-rust")).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-hint")).toHaveTextContent("brew install jdtls");
    expect(screen.queryByText("rustup component add rust-analyzer")).not.toBeInTheDocument();
  });

  it("copies install instructions to the clipboard", async () => {
    render(<LanguageServersSettings />);
    await screen.findByTestId("language-servers-install-hint");
    fireEvent.click(screen.getByTestId("language-servers-copy-install-hint"));
    expect(writeTextMock).toHaveBeenCalledWith("brew install jdtls  # JDK 17+");
  });

  it("persists command preference selection", async () => {
    render(<LanguageServersSettings />);
    const select = await screen.findByLabelText("Java language server command");
    fireEvent.change(select, { target: { value: "__custom__" } });
    await waitFor(() => {
      expect(window.localStorage.getItem("taomni.codeWorkspace.lspCommandPrefs.v1")).toBe(
        JSON.stringify({ java: "__custom__" }),
      );
    });
    fireEvent.change(screen.getByLabelText("Java custom command"), {
      target: { value: "/opt/jdtls/bin/jdtls" },
    });
    await waitFor(() => {
      expect(window.localStorage.getItem("taomni.codeWorkspace.lspCustomCommands.v1")).toContain(
        "/opt/jdtls/bin/jdtls",
      );
    });
  });
});
