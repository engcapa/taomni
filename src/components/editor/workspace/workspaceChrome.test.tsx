import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspDocumentStatus } from "../../../lib/editor/lsp";
import { emptyLspFileState } from "./codeWorkspaceModel";
import { LspStatusPill, lspNeedsSetup } from "./workspaceChrome";

vi.mock("../../../lib/i18n", () => ({
  useT: () => (key: string) => key,
}));

afterEach(() => {
  cleanup();
});

function lspState(overrides: {
  status?: Partial<LspDocumentStatus>;
  syncing?: boolean;
  error?: string | null;
} = {}) {
  return {
    ...emptyLspFileState(),
    syncing: overrides.syncing ?? false,
    error: overrides.error ?? null,
    status: {
      path: "src/Main.ts",
      uri: "file:///src/Main.ts",
      presetId: "typescript",
      languageId: "typescript",
      displayName: "TypeScript",
      available: false,
      active: false,
      selectedCommandId: null,
      selectedCommand: null,
      installHint: "npm install -g typescript-language-server",
      error: null,
      ...overrides.status,
    },
  };
}

describe("lspNeedsSetup", () => {
  it("is true when the language server is inactive with an install hint", () => {
    expect(lspNeedsSetup(lspState())).toBe(true);
  });

  it("is false while the document is still syncing", () => {
    expect(lspNeedsSetup(lspState({ syncing: true }))).toBe(false);
  });

  it("is false when the language server is active", () => {
    expect(lspNeedsSetup(lspState({ status: { active: true, available: true } }))).toBe(false);
  });
});

describe("LspStatusPill", () => {
  it("shows a settings link when LSP setup is required", () => {
    const onOpenSettings = vi.fn();
    render(
      <LspStatusPill
        state={lspState()}
        diagnostics={[]}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByText(/Install: npm install -g typescript-language-server/)).toBeInTheDocument();
    const link = screen.getByTestId("code-workspace-lsp-open-settings");
    expect(link).toHaveTextContent("settings.languageServersOpenSettings");
    fireEvent.click(link);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("hides the settings link when the language server is active", () => {
    render(
      <LspStatusPill
        state={lspState({ status: { active: true, available: true, installHint: null } })}
        diagnostics={[]}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.queryByTestId("code-workspace-lsp-open-settings")).not.toBeInTheDocument();
  });
});