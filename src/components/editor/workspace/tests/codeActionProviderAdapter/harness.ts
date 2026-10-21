import type { LspDiagnostic, LspRange } from "../../../../../lib/editor/lsp";

export const testEvidenceInput = {
  languageId: "java",
  provider: { id: "jdtls", version: "1.61.0", generation: 3 },
  projectFingerprint: "fp-test-1234",
  uri: "file:///workspace/src/App.java",
  revision: 5,
} as const;

export const sampleDiagnostic: LspDiagnostic = {
  range: { start: { line: 10, character: 2 }, end: { line: 10, character: 15 } },
  severity: 1,
  code: "cannot-resolve",
  source: "Java",
  message: "StringUtils cannot be resolved",
};

export const sampleRange: LspRange = {
  start: { line: 10, character: 2 },
  end: { line: 10, character: 15 },
};
