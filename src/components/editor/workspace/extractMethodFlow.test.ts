import { describe, expect, it } from "vitest";
import type { LspDocumentSymbol } from "../../../lib/editor/lsp";
import {
  EXTRACT_NAMING_UNAVAILABLE_MESSAGE,
  extractBufferMatches,
  extractDirtyBufferMessage,
  extractMethodBoundaryMessage,
  extractOwnerMatches,
  extractReceiptMatches,
  findExtractedMethodSymbol,
  isExtractMethodKind,
  type ExtractSession,
} from "./extractMethodFlow";

function symbol(
  name: string,
  kind: number,
  depth: number,
  startLine: number,
  startCharacter: number,
): LspDocumentSymbol {
  const start = { line: startLine, character: startCharacter };
  const end = { line: startLine, character: startCharacter + name.length };
  return {
    name,
    detail: null,
    kind,
    depth,
    range: { start: { line: startLine, character: 0 }, end },
    selectionRange: { start, end },
  };
}

const CLASS = 5;
const METHOD = 6;

describe("ED-PARITY-007: extract method flow model", () => {
  it("isExtractMethodKind accepts function/method kinds only", () => {
    expect(isExtractMethodKind("refactor.extract.function")).toBe(true);
    expect(isExtractMethodKind("refactor.extract.method")).toBe(true);
    expect(isExtractMethodKind("refactor.extract.function.custom")).toBe(true);
    expect(isExtractMethodKind("refactor.extract.method.inline")).toBe(true);

    // Parent kinds keep their variable/constant/field/interface members; the
    // title never upgrades a parent kind into a method extraction.
    expect(isExtractMethodKind("refactor.extract")).toBe(false);
    expect(isExtractMethodKind("refactor.extract.variable")).toBe(false);
    expect(isExtractMethodKind("refactor.extract.constant")).toBe(false);
    expect(isExtractMethodKind("refactor.extract.field")).toBe(false);
    expect(isExtractMethodKind("refactor.extract.interface")).toBe(false);
    expect(isExtractMethodKind("refactor")).toBe(false);
    expect(isExtractMethodKind(null)).toBe(false);
    expect(isExtractMethodKind(undefined)).toBe(false);
    expect(isExtractMethodKind("")).toBe(false);
  });

  it("findExtractedMethodSymbol returns the single new method", () => {
    const before = [
      symbol("ExtractTarget", CLASS, 0, 2, 0),
      symbol("total", METHOD, 1, 4, 11),
      symbol("helper", METHOD, 1, 8, 11),
      symbol("main", METHOD, 1, 12, 11),
    ];
    const after = [
      symbol("ExtractTarget", CLASS, 0, 2, 0),
      symbol("total", METHOD, 1, 4, 11),
      symbol("extracted", METHOD, 1, 6, 15),
      symbol("helper", METHOD, 1, 8, 11),
      symbol("main", METHOD, 1, 12, 11),
    ];
    const found = findExtractedMethodSymbol(before, after);
    expect(found?.name).toBe("extracted");
    expect(found?.selectionRange.start).toEqual({ line: 6, character: 15 });
  });

  it("findExtractedMethodSymbol refuses ambiguity", () => {
    const before = [
      symbol("ExtractTarget", CLASS, 0, 2, 0),
      symbol("total", METHOD, 1, 4, 11),
    ];
    const twoNew = [
      ...before,
      symbol("extracted", METHOD, 1, 6, 15),
      symbol("other", METHOD, 1, 10, 15),
    ];
    expect(findExtractedMethodSymbol(before, twoNew)).toBeNull();
    expect(findExtractedMethodSymbol(before, before)).toBeNull();
    // Same-name member of an existing container is an overload, not the new method.
    const overload = [...before, symbol("total", METHOD, 1, 6, 11)];
    expect(findExtractedMethodSymbol(before, overload)).toBeNull();
  });

  it("method symbol matching refuses same-name overloads and ambiguous containers", () => {
    const before = [
      symbol("ExtractTarget", CLASS, 0, 2, 0),
      symbol("total", METHOD, 1, 4, 11),
      symbol("Inner", CLASS, 1, 7, 8),
      symbol("total", METHOD, 2, 8, 12),
    ];
    // A different container may legitimately gain a same-named method.
    const nestedNew = [...before, symbol("run", METHOD, 2, 10, 12)];
    expect(findExtractedMethodSymbol(before, nestedNew)?.name).toBe("run");
    // Adding to the container that already had that name is still an overload.
    const nestedOverload = [...before, symbol("total", METHOD, 2, 10, 12)];
    expect(findExtractedMethodSymbol(before, nestedOverload)).toBeNull();
    // A second container with the same name chain is ambiguous, not guessable.
    const ambiguous = [
      ...before,
      symbol("Other", CLASS, 1, 12, 8),
      symbol("run", METHOD, 2, 13, 12),
      symbol("run", METHOD, 1, 20, 12),
    ];
    expect(findExtractedMethodSymbol(before, ambiguous)).toBeNull();
  });

  it("boundary message distinguishes empty and non-empty selections", () => {
    expect(extractMethodBoundaryMessage(true)).toBe(
      "Extract Method: select the statements or expression to extract",
    );
    expect(extractMethodBoundaryMessage(false)).toBe(
      "Extract Method is not available for this selection (the language server offers no extraction here, for example when several values would have to be returned)",
    );
  });

  it("session guard rejects closed and reopened owners", () => {
    const session: ExtractSession = {
      id: "extract-1",
      workspaceInstance: "instance-a",
      sourceViewId: "group-1",
      fileKey: "root:app:src/ExtractTarget.java",
      uri: "file:///repo/app/src/ExtractTarget.java",
      providerGeneration: 7,
      projectFingerprint: "fp-1",
      baseRevision: 3,
      baseText: "class A {}",
      selection: { start: { line: 4, character: 0 }, end: { line: 7, character: 0 } },
      phase: "request",
    };
    const owner = {
      sessionId: "extract-1",
      workspaceInstance: "instance-a",
      sourceViewId: "group-1",
      fileKey: session.fileKey,
      uri: session.uri,
      providerGeneration: 7,
      projectFingerprint: "fp-1",
    };
    expect(extractOwnerMatches(session, owner)).toBe(true);
    // Closed (session dropped) and reopened under the same key: a new id.
    expect(extractOwnerMatches(null, owner)).toBe(false);
    expect(extractOwnerMatches(session, { ...owner, sessionId: "extract-2" })).toBe(false);
    expect(extractOwnerMatches(session, { ...owner, sourceViewId: "group-2" })).toBe(false);
    expect(extractOwnerMatches(session, { ...owner, workspaceInstance: "instance-b" })).toBe(false);
    expect(extractOwnerMatches(session, { ...owner, uri: "file:///repo/app/Other.java" })).toBe(false);
    expect(extractOwnerMatches(session, { ...owner, providerGeneration: 8 })).toBe(false);
    expect(extractOwnerMatches(session, { ...owner, projectFingerprint: "fp-2" })).toBe(false);
    expect(extractOwnerMatches({ ...session, phase: "finished" }, owner)).toBe(false);

    const base = { revision: 3, text: "class A {}" };
    expect(extractBufferMatches(base, { ...base })).toBe(true);
    expect(extractBufferMatches(base, { revision: 4, text: base.text })).toBe(false);
    expect(extractBufferMatches(base, { revision: 3, text: "class A { }" })).toBe(false);
    expect(extractBufferMatches(base, null)).toBe(false);
  });

  it("receipt requires exact post revision and text", () => {
    const receipt = {
      sessionId: "extract-1",
      fileKey: "root:app:src/ExtractTarget.java",
      uri: "file:///repo/app/src/ExtractTarget.java",
      postRevision: 5,
      postText: "class A { int sumOf() {} }",
      historyId: "ca-hist-1",
    };
    expect(extractReceiptMatches(receipt, { revision: 5, text: receipt.postText })).toBe(true);
    // A later user edit or undo must never be rebound to the receipt.
    expect(extractReceiptMatches(receipt, { revision: 6, text: receipt.postText })).toBe(false);
    expect(extractReceiptMatches(receipt, { revision: 5, text: "class A {}" })).toBe(false);
    expect(extractReceiptMatches(receipt, null)).toBe(false);
    expect(extractReceiptMatches(null, { revision: 5, text: receipt.postText })).toBe(false);

    expect(extractDirtyBufferMessage("sumOf")).toContain("save the file, then press Shift+F6");
    expect(extractDirtyBufferMessage("sumOf")).toContain("sumOf");
    expect(EXTRACT_NAMING_UNAVAILABLE_MESSAGE).toBe(
      "Extracted method; could not locate the new method to rename it",
    );
  });
});
