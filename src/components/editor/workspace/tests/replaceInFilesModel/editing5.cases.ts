import { describe, expect, it } from "vitest";
import { validateReplacePreflight, validateReplacePreviewSelection, type ReplacePreflightFileInput, type ReplacePreviewSnapshot } from "../../replaceInFilesModel";

export function registerreplaceInFilesModelEditing5Cases() {

  describe("ED-REPAIR-002: replace preflight and open buffer freeze conditions", () => {
    const sampleSnapshot: ReplacePreviewSnapshot = {
      scope: { kind: "workspace", roots: ["/ws"], explicitFiles: [], fileMask: null, generation: null },
      query: { query: "target", caseSensitive: false, wholeWord: false, regexp: false, includeGlobs: [], excludeGlobs: [] },
      replacement: "replacement",
      matchKeys: [
        "/ws/fileA.ts:0:0:0:6:target",
        "/ws/fileB.ts:0:0:0:6:target",
      ],
      matchCount: 2,
      editSignature: "sig-123",
      capturedAt: 1000,
      requestIdentity: {
        token: 1,
        workspaceInstanceId: "ws-1",
        scope: { kind: "workspace", roots: ["/ws"], explicitFiles: [], fileMask: null, generation: null },
        query: { query: "target", caseSensitive: false, wholeWord: false, regexp: false, includeGlobs: [], excludeGlobs: [] },
        replacement: "replacement",
        matchKeys: [
          "/ws/fileA.ts:0:0:0:6:target",
          "/ws/fileB.ts:0:0:0:6:target",
        ],
        matchCount: 2,
        preparedAt: 1000,
      },
      preimages: [
        {
          path: "/ws/fileA.ts",
          uri: "file:///ws/fileA.ts",
          textHash: "hash-a",
          encoding: "UTF-8",
          bom: false,
          eol: "lf",
          bufferRevision: 5,
          dirty: false,
          readOnly: false,
          workspaceInstanceId: "ws-1",
        },
        {
          path: "/ws/fileB.ts",
          uri: "file:///ws/fileB.ts",
          textHash: "hash-b",
          encoding: "UTF-8",
          bom: false,
          eol: "lf",
          bufferRevision: null,
          dirty: false,
          readOnly: false,
          workspaceInstanceId: "ws-1",
        },
      ],
    };

    it("validateReplacePreviewSelection rejects non-text resource operations (ED-REPAIR-002-A2)", () => {
      const editWithRename: any = {
        operations: [
          {
            kind: "text",
            document: {
              uri: "file:///ws/fileA.ts",
              path: "/ws/fileA.ts",
              edits: [
                { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "replacement" },
              ],
            },
          },
          {
            kind: "rename",
            oldUri: "file:///ws/fileB.ts",
            newUri: "file:///ws/fileB-renamed.ts",
          },
        ],
        documentEdits: [
          {
            uri: "file:///ws/fileA.ts",
            path: "/ws/fileA.ts",
            edits: [
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "replacement" },
            ],
          },
        ],
      };

      const result = validateReplacePreviewSelection(
        sampleSnapshot,
        new Set(["/ws/fileA.ts:0:0:0:6:target"]),
        editWithRename,
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Resource operations are not permitted");
    });

    it("validateReplacePreviewSelection rejects duplicate edits for same path/range (ED-REPAIR-002-A2)", () => {
      const editWithDuplicate: any = {
        documentEdits: [
          {
            uri: "file:///ws/fileA.ts",
            path: "/ws/fileA.ts",
            edits: [
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "replacement" },
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "replacement" },
            ],
          },
        ],
      };

      const result = validateReplacePreviewSelection(
        sampleSnapshot,
        new Set(["/ws/fileA.ts:0:0:0:6:target", "/ws/fileB.ts:0:0:0:6:target"]),
        editWithDuplicate,
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Duplicate edit detected");
    });

    it("validateReplacePreviewSelection rejects forged same-count edit not in sourceEdit (ED-REPAIR-002-A2)", () => {
      const sourceEdit: any = {
        documentEdits: [
          {
            uri: "file:///ws/fileA.ts",
            path: "/ws/fileA.ts",
            edits: [
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "replacement" },
            ],
          },
        ],
      };
      const forgedEdit: any = {
        documentEdits: [
          {
            uri: "file:///ws/fileA.ts",
            path: "/ws/fileA.ts",
            edits: [
              { range: { start: { line: 10, character: 0 }, end: { line: 10, character: 6 } }, newText: "replacement" },
            ],
          },
        ],
      };

      const result = validateReplacePreviewSelection(
        sampleSnapshot,
        new Set(["/ws/fileA.ts:0:0:0:6:target"]),
        forgedEdit,
        sourceEdit,
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("not part of the original replace plan");
    });

    it("validateReplacePreflight accepts matching clean disk and buffer preimages (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: true,
          openBufferRevision: 5,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
        {
          path: "/ws/fileB.ts",
          exists: true,
          diskHash: "hash-b",
          diskText: "target b",
          isOpen: false,
          openBufferRevision: null,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-1", files);
      expect(result.canCommit).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it("validateReplacePreflight rejects when workspace instance mismatches (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: true,
          openBufferRevision: 5,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-switched", files);
      expect(result.canCommit).toBe(false);
      expect(result.conflicts[0].reason).toContain("workspace instance mismatch");
    });

    it("validateReplacePreflight rejects missing or unreadable file (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: false,
          diskHash: null,
          diskText: null,
          isOpen: true,
          openBufferRevision: 5,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-1", files);
      expect(result.canCommit).toBe(false);
      expect(result.conflicts[0].reason).toContain("file not found on disk or unreadable");
    });

    it("validateReplacePreflight rejects disk hash change on file B (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: true,
          openBufferRevision: 5,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
        {
          path: "/ws/fileB.ts",
          exists: true,
          diskHash: "hash-b-modified",
          diskText: "target b!",
          isOpen: false,
          openBufferRevision: null,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-1", files);
      expect(result.canCommit).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].path).toBe("/ws/fileB.ts");
      expect(result.conflicts[0].reason).toContain("changed on disk since the frozen replace preview");
    });

    it("validateReplacePreflight rejects open buffer revision mismatch (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: true,
          openBufferRevision: 6,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-1", files);
      expect(result.canCommit).toBe(false);
      expect(result.conflicts[0].path).toBe("/ws/fileA.ts");
      expect(result.conflicts[0].reason).toContain("modified in the editor");
    });

    it("validateReplacePreflight rejects dirty open buffer (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: true,
          openBufferRevision: 5,
          openBufferDirty: true,
          openBufferReadOnly: false,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-1", files);
      expect(result.canCommit).toBe(false);
      expect(result.conflicts[0].path).toBe("/ws/fileA.ts");
      expect(result.conflicts[0].reason).toContain("unsaved modifications in the editor");
    });

    it("validateReplacePreflight rejects read-only open buffer (ED-REPAIR-002-A1)", () => {
      const files: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: true,
          openBufferRevision: 5,
          openBufferDirty: false,
          openBufferReadOnly: true,
        },
      ];

      const result = validateReplacePreflight(sampleSnapshot, "ws-1", files);
      expect(result.canCommit).toBe(false);
      expect(result.conflicts[0].path).toBe("/ws/fileA.ts");
      expect(result.conflicts[0].reason).toContain("read-only");
    });

    it("validateReplacePreflight rejects open/closed session flip (ED-REPAIR-002-A1)", () => {
      const fileBOpened: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileB.ts",
          exists: true,
          diskHash: "hash-b",
          diskText: "target b",
          isOpen: true,
          openBufferRevision: 1,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result1 = validateReplacePreflight(sampleSnapshot, "ws-1", fileBOpened);
      expect(result1.canCommit).toBe(false);
      expect(result1.conflicts[0].reason).toContain("was opened in the editor since the frozen preview");

      const fileAClosed: ReplacePreflightFileInput[] = [
        {
          path: "/ws/fileA.ts",
          exists: true,
          diskHash: "hash-a",
          diskText: "target a",
          isOpen: false,
          openBufferRevision: null,
          openBufferDirty: false,
          openBufferReadOnly: false,
        },
      ];

      const result2 = validateReplacePreflight(sampleSnapshot, "ws-1", fileAClosed);
      expect(result2.canCommit).toBe(false);
      expect(result2.conflicts[0].reason).toContain("was closed in the editor since the frozen preview");
    });
  });
}
