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
      installHint: "Requires JDK 17+. Linux: …",
      error: null,
      commands: [
        {
          id: "jdtls",
          label: "jdtls",
          command: "jdtls",
          args: [],
          installHint: "Requires JDK 17+. Linux: …",
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
  it("lists servers and keeps install commands collapsed by default", async () => {
    render(<LanguageServersSettings />);
    expect(await screen.findByTestId("language-server-row-java")).toBeInTheDocument();
    expect(screen.getByTestId("language-server-row-rust")).toBeInTheDocument();
    // Collapsed: no install command body visible.
    expect(screen.queryByTestId("language-servers-install-panel")).not.toBeInTheDocument();
    expect(screen.queryByText("brew install jdtls")).not.toBeInTheDocument();
    // Both missing and installed servers expose a show-install control.
    expect(screen.getAllByTestId("language-servers-install-toggle")).toHaveLength(2);
  });

  it("expands multi-OS install commands for jdtls with real URLs and copies the script", async () => {
    render(<LanguageServersSettings />);
    const javaRow = await screen.findByTestId("language-server-row-java");
    const toggle = javaRow.querySelector(
      "[data-testid='language-servers-install-toggle']",
    ) as HTMLButtonElement;
    fireEvent.click(toggle);

    expect(await screen.findByTestId("language-servers-install-panel")).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-line-linux")).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-line-macos")).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-line-windows")).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-note-linux")).toHaveTextContent(/JDK 17/i);
    expect(screen.getAllByText(/jdt-language-server-latest\.tar\.gz/).length).toBeGreaterThan(0);
    expect(screen.getByText(/brew install jdtls/)).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-hint")).toHaveTextContent("config_linux");

    fireEvent.click(screen.getByTestId("language-servers-copy-install-macos"));
    expect(writeTextMock).toHaveBeenCalled();
    const copied = String(writeTextMock.mock.calls[0][0]);
    expect(copied).toContain("brew install jdtls");
  });

  it("shows install commands for already-installed servers as a single shared line", async () => {
    render(<LanguageServersSettings />);
    const rustRow = await screen.findByTestId("language-server-row-rust");
    fireEvent.click(rustRow.querySelector(
      "[data-testid='language-servers-install-toggle']",
    ) as HTMLButtonElement);

    expect(await screen.findByTestId("language-servers-install-panel")).toBeInTheDocument();
    expect(screen.getByTestId("language-servers-install-line-shared")).toBeInTheDocument();
    expect(screen.getByText(/rustup component add rust-analyzer/)).toBeInTheDocument();
    // Shared catalog entry → no OS labels.
    expect(screen.queryByTestId("language-servers-install-line-linux")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("language-servers-copy-install-shared"));
    expect(writeTextMock).toHaveBeenCalled();
    expect(String(writeTextMock.mock.calls[0][0])).toContain("rustup component add rust-analyzer");
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
