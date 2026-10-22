import { describe, expect, it } from "vitest";
import { isCleanupActionKind, isRearrangeActionKind, validateWorkflowProviderAction } from "../../rearrangeCleanupWorkflow";

export function registerrearrangeCleanupWorkflowBehavior5Cases() {

  // ---------------------------------------------------------------------------
  // ED-IMPROVE-003: the complete provider payload must be validated before it
  // can become a plan; silent filtering/partial execution is not allowed.
  // ---------------------------------------------------------------------------
  describe("ED-IMPROVE-003: provider action payload validation (model boundary)", () => {
    const TEXT = "class A {\n  void beta() {}\n  void alpha() {}\n}\n";
    const TARGET_URI = "file:///repo/src/A.java";
    const TARGET_PATH = "/repo/src/A.java";
    const EDIT = {
      range: {
        start: { line: 1, character: 0 },
        end: { line: 2, character: 15 },
      },
      newText: "  void alpha() {}\n  void beta() {}",
    };

    function payload(overrides: Record<string, unknown> = {}) {
      return {
        kind: "source.rearrange",
        title: "Rearrange members",
        edit: {
          documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [EDIT] }],
        },
        command: null,
        commandArguments: null,
        raw: {},
        ...overrides,
      };
    }

    function validate(action: ReturnType<typeof payload> | null, revision?: number) {
      return validateWorkflowProviderAction({
        action,
        targetUri: TARGET_URI,
        targetPath: TARGET_PATH,
        documentText: TEXT,
        documentRevision: revision,
        documentVersion: revision,
        isSupportedKind: isRearrangeActionKind,
        capabilityLabel: "Rearrange Code",
      });
    }

    it("accepts a current-file-only text-edit payload", () => {
      const result = validate(payload());
      expect(result).toEqual({ ok: true, edits: [EDIT], documentVersion: null });
    });

    it("rejects a cross-file edit instead of filtering it out", () => {
      const result = validate(payload({
        edit: {
          documentEdits: [
            { uri: TARGET_URI, path: TARGET_PATH, edits: [EDIT] },
            { uri: "file:///repo/src/B.java", path: "/repo/src/B.java", edits: [EDIT] },
          ],
        },
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.state).toBe("unsupported");
        expect(result.reason).toContain("/repo/src/B.java");
        expect(result.reason).toContain("nothing applied");
      }
    });

    it("accepts an LSP documentChanges text operation payload", () => {
      const result = validate(payload({
        edit: {
          documentEdits: [],
          operations: [{ kind: "text", document: { uri: TARGET_URI, path: TARGET_PATH, edits: [EDIT] } }],
        },
      }));
      expect(result).toEqual({ ok: true, edits: [EDIT], documentVersion: null });
    });

    it("rejects resource operations even when a text edit is present", () => {
      const result = validate(payload({
        edit: {
          documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [EDIT] }],
          operations: [{ kind: "rename", oldUri: TARGET_URI, newUri: "file:///repo/src/B.java" }],
        },
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("resource operations (rename)");
    });

    it("rejects a command-only payload and an edit+command payload", () => {
      const commandOnly = validate(payload({ edit: null, command: "editor.action.foo" }));
      expect(commandOnly.ok).toBe(false);
      if (!commandOnly.ok) expect(commandOnly.reason).toContain("command-only");

      const mixed = validate(payload({ command: "editor.action.foo" }));
      expect(mixed.ok).toBe(false);
      if (!mixed.ok) expect(mixed.reason).toContain("both an edit and the command");
    });

    it("rejects URI/path contradictions and foreign URIs", () => {
      const contradiction = validate(payload({
        edit: { documentEdits: [{ uri: TARGET_URI, path: "/repo/src/Other.java", edits: [EDIT] }] },
      }));
      expect(contradiction.ok).toBe(false);
      if (!contradiction.ok) expect(contradiction.reason).toContain("contradictory");

      const foreignUri = validate(payload({
        edit: { documentEdits: [{ uri: "file:///repo/src/B.java", edits: [EDIT] }] },
      }));
      expect(foreignUri.ok).toBe(false);
      if (!foreignUri.ok) expect(foreignUri.reason).toContain("different document");

      const malformed = validate(payload({
        edit: { documentEdits: [{ edits: [EDIT] }] },
      }));
      expect(malformed.ok).toBe(false);
      if (!malformed.ok) expect(malformed.reason).toContain("malformed");
    });

    it("rejects disabled actions", () => {
      const result = validate(payload({ raw: { disabled: true } }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.state).toBe("unsupported");
        expect(result.reason).toContain("disabled");
      }
    });

    it("rejects the standard disabled reason object and surfaces the reason", () => {
      const result = validate(payload({ raw: { disabled: { reason: "cannot sort members" } } }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.state).toBe("unsupported");
        expect(result.reason).toContain("disabled");
        expect(result.reason).toContain("cannot sort members");
      }
    });

    it("rejects an empty disabled object with a fallback reason", () => {
      const result = validate(payload({ raw: { disabled: {} } }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.state).toBe("unsupported");
        expect(result.reason).toContain("did not supply a reason");
      }
    });

    it("does not reject null/false/absent disabled values", () => {
      for (const raw of [{ disabled: null }, { disabled: false }, {}, { disabled: "no" }]) {
        expect(validate(payload({ raw })).ok).toBe(true);
      }
    });

    it("rejects malformed and reversed ranges but keeps clamping-compatible ones", () => {
      const reversed = validate(payload({
        edit: {
          documentEdits: [{
            uri: TARGET_URI,
            path: TARGET_PATH,
            edits: [{
              range: { start: { line: 2, character: 5 }, end: { line: 1, character: 0 } },
              newText: "x",
            }],
          }],
        },
      }));
      expect(reversed.ok).toBe(false);
      if (!reversed.ok) {
        expect(reversed.state).toBe("failed");
        expect(reversed.reason).toContain("malformed or reversed");
      }

      const negative = validate(payload({
        edit: {
          documentEdits: [{
            uri: TARGET_URI,
            path: TARGET_PATH,
            edits: [{
              range: { start: { line: 1, character: -2 }, end: { line: 1, character: 3 } },
              newText: "x",
            }],
          }],
        },
      }));
      expect(negative.ok).toBe(false);

      // A real provider can address past the last line; the canonical applier
      // clamps those, so they stay valid here and the postcondition decides.
      const pastEnd = validate(payload({
        edit: {
          documentEdits: [{
            uri: TARGET_URI,
            path: TARGET_PATH,
            edits: [{
              range: { start: { line: 3, character: 1 }, end: { line: 16, character: 31 } },
              newText: "  void alpha() {}\n  void beta() {}",
            }],
          }],
        },
      }));
      expect(pastEnd.ok).toBe(true);
    });

    it("rejects a version mismatch as stale", () => {
      const result = validate(payload({
        edit: {
          documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, version: 4, edits: [EDIT] }],
        },
      }), 7);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.state).toBe("stale");
        expect(result.reason).toContain("version 4");
        expect(result.reason).toContain("7");
      }
    });

    it("accepts a versioned edit whose LSP version matches the provider document (ED-MAIN-003)", () => {
      const result = validate(payload({
        edit: {
          documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, version: 7, edits: [EDIT] }],
        },
      }), 7);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.documentVersion).toBe(7);
        expect(result.edits).toEqual([EDIT]);
      }
    });

    it("rejects a versioned edit when the provider-synchronized version is unknown (ED-MAIN-003)", () => {
      const result = validateWorkflowProviderAction({
        action: payload({
          edit: {
            documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, version: 7, edits: [EDIT] }],
          },
        }),
        targetUri: TARGET_URI,
        targetPath: TARGET_PATH,
        documentText: TEXT,
        documentRevision: 99,
        documentVersion: null,
        isSupportedKind: isRearrangeActionKind,
        capabilityLabel: "Rearrange Code",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.state).toBe("stale");
        expect(result.reason).toContain("provider-synchronized document version is unknown");
      }
    });

    it("keeps an unversioned payload on the hash gates with a null document version (ED-MAIN-003)", () => {
      const result = validate(payload());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.documentVersion).toBeNull();
    });

    it("rejects a null action and an unsupported resolved kind", () => {
      const nullAction = validate(null);
      expect(nullAction.ok).toBe(false);
      if (!nullAction.ok) expect(nullAction.state).toBe("failed");

      const wrongKind = validate(payload({ kind: "quickfix" }));
      expect(wrongKind.ok).toBe(false);
      if (!wrongKind.ok) expect(wrongKind.reason).toContain("dedicated action kind");
    });

    it("treats generic source.fixAll as not-cleanup while dedicated kinds stay accepted", () => {
      expect(isCleanupActionKind("source.fixAll")).toBe(false);
      expect(isCleanupActionKind("source.cleanup")).toBe(true);
      expect(isCleanupActionKind("cleanup")).toBe(true);
      expect(isRearrangeActionKind("source.sortMembers")).toBe(true);
    });
  });
}
