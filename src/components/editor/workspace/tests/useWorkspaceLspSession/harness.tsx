import { vi } from "vitest";
import type { LspDocumentStatus } from "../../../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../../../types";
import type { OpenFileState } from "../../codeWorkspaceModel";

vi.mock("@tauri-apps/api/event", () => import("../../../../../stubs/tauri-event"));

const lspMocks = vi.hoisted(() => ({
  lspDetectServers: vi.fn(),
  lspDiscoverJavaBundles: vi.fn(),
  lspSetJavaHome: vi.fn(),
  lspSetJavaVmargs: vi.fn(),
  lspSetJavaSettings: vi.fn(),
  lspSetJavaBundles: vi.fn(),
  lspOpenDocument: vi.fn(),
  lspChangeDocument: vi.fn(),
  lspSaveDocument: vi.fn(),
  lspCloseDocument: vi.fn(),
  lspStopWorkspace: vi.fn(),
  lspGetDiagnostics: vi.fn(),
}));

vi.mock("../../../../../lib/editor/lsp", () => lspMocks);

export const roots: CodeWorkspaceRootInfo[] = [{
  id: "root-1",
  name: "repo",
  path: "/repo",
  kind: "folder",
}];

export const status: LspDocumentStatus = {
  path: "/repo/src/main.ts",
  uri: "file:///repo/src/main.ts",
  presetId: "typescript",
  languageId: "typescript",
  displayName: "TypeScript",
  available: true,
  active: true,
  selectedCommandId: "typescript-language-server",
  selectedCommand: "typescript-language-server",
  installHint: null,
  error: null,
};

export const incrementalStatus: LspDocumentStatus = {
  ...status,
  capabilities: {
    textDocumentSyncKind: 2,
    completion: false,
    signatureHelp: false,
    hover: false,
    definition: false,
    typeDefinition: false,
    implementation: false,
    references: false,
    documentSymbol: false,
    workspaceSymbol: false,
    rename: false,
    formatting: false,
    rangeFormatting: false,
    codeAction: false,
    documentHighlight: false,
    callHierarchy: false,
    typeHierarchy: false,
    inlayHint: false,
    selectionRange: false,
    semanticTokens: false,
    completionTriggerCharacters: [],
    signatureTriggerCharacters: [],
  },
};

export const file: OpenFileState = {
  key: "root:root-1:src/main.ts",
  ref: { kind: "root", rootId: "root-1", path: "src/main.ts" },
  title: "main.ts",
  subtitle: "repo / src/main.ts",
  path: "src/main.ts",
  languagePath: "src/main.ts",
  text: "const value = 1;",
  savedText: "const value = 1;",
  eol: "LF",
  size: 16,
  mtime: 1,
  hash: "hash",
  loading: false,
  saving: false,
  dirty: false,
  documentRevision: 0,
  error: null,
};

export { lspMocks };
