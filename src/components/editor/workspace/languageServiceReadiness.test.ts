import { describe, expect, it } from "vitest";
import type { LspDocumentStatus } from "../../../lib/editor/lsp";
import type { LspFileState } from "./codeWorkspaceModel";
import { languageServiceReadiness } from "./languageServiceReadiness";

function state(status: Partial<LspDocumentStatus> | null, extra: Partial<LspFileState> = {}): LspFileState {
  return {
    status: status === null ? null : {
      path: "/repo/A.java",
      uri: "file:///repo/A.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: false,
      selectedCommandId: "jdtls",
      selectedCommand: "jdtls",
      installHint: null,
      error: null,
      ...status,
    },
    diagnostics: [],
    diagnosticScope: null,
    syncing: false,
    syncedText: null,
    error: null,
    errorGeneration: 0,
    ...extra,
  };
}

describe("ED-PARITY-015 languageServiceReadiness", () => {
  it("maps every provider state to one kind, message and recovery action", () => {
    expect(languageServiceReadiness(null)).toMatchObject({ kind: "idle", action: null });
    expect(languageServiceReadiness(state({ active: true }))).toMatchObject({ kind: "ready", message: "Java" });
    expect(languageServiceReadiness(state({ active: true, semanticReady: false }))).toMatchObject({ kind: "indexing", message: "Java indexing…", action: null });
    expect(languageServiceReadiness(state({}, { syncing: true }))).toMatchObject({ kind: "starting", action: null });
    expect(languageServiceReadiness(state({}))).toMatchObject({ kind: "inactive", action: "retry" });
    expect(languageServiceReadiness(state({ error: "jdtls exited" }))).toMatchObject({ kind: "failed", message: "jdtls exited", action: "retry" });
    expect(languageServiceReadiness(state({ available: false, error: "not in browser" }))).toMatchObject({ kind: "failed", action: "configure" });
    expect(languageServiceReadiness(state({ available: false, installHint: "jdtls" }))).toMatchObject({ kind: "not-installed", message: "Install: jdtls", action: "configure" });
    expect(languageServiceReadiness(state({ available: false }))).toMatchObject({ kind: "not-installed", message: "No LSP", action: "configure" });
    expect(languageServiceReadiness(state({ available: false, presetId: null }))).toMatchObject({ kind: "idle", message: "No LSP", action: null });
  });
});
