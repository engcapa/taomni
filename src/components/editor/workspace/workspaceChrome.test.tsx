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
  it("is true when the language server binary is missing", () => {
    expect(lspNeedsSetup(lspState({
      status: { available: false, installHint: "npm install -g typescript-language-server" },
    }))).toBe(true);
  });

  it("is false while the document is still syncing", () => {
    expect(lspNeedsSetup(lspState({ syncing: true }))).toBe(false);
  });

  it("is false when the language server is active", () => {
    expect(lspNeedsSetup(lspState({ status: { active: true, available: true } }))).toBe(false);
  });

  it("is false when the binary is available but the session is not active yet", () => {
    expect(lspNeedsSetup(lspState({
      status: {
        available: true,
        active: false,
        installHint: null,
        error: null,
      },
    }))).toBe(false);
  });

  it("is true when available but start failed with an error", () => {
    expect(lspNeedsSetup(lspState({
      status: {
        available: true,
        active: false,
        installHint: null,
        error: "spawn jdtls: %1 is not a valid Win32 application",
      },
    }))).toBe(true);
  });
});

describe("LspStatusPill", () => {
  it("shows a settings link when the language server is not installed", () => {
    const onOpenSettings = vi.fn();
    render(
      <LspStatusPill
        state={lspState({
          status: { available: false, installHint: "npm install -g typescript-language-server" },
        })}
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

  it("shows runtime errors instead of a misleading Install hint", () => {
    render(
      <LspStatusPill
        state={lspState({
          status: {
            available: true,
            active: false,
            displayName: "Java",
            installHint: "Requires JDK 17+",
            error: "language server request timed out: initialize",
          },
        })}
        diagnostics={[]}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("language server request timed out: initialize")).toBeInTheDocument();
    expect(screen.queryByText(/Install:/)).not.toBeInTheDocument();
  });

  it("shows starting when available but not yet active", () => {
    render(
      <LspStatusPill
        state={lspState({
          status: {
            available: true,
            active: false,
            displayName: "Java",
            installHint: null,
            error: null,
          },
        })}
        diagnostics={[]}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("Java starting…")).toBeInTheDocument();
    expect(screen.queryByTestId("code-workspace-lsp-open-settings")).not.toBeInTheDocument();
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
