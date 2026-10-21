import { describe, expect, it } from "vitest";
import {
  collectReplacePreimages,
  replaceMatchStableKey,
  type ReplaceInFilesMatch,
  type ReplacePrepareRequestIdentity,
  type ReplacePreviewSnapshot,
  type ReplaceScopeIdentity,
} from "../../replaceInFilesModel";

export interface registerreplaceInFilesModelEditing4CasesContext {
  sampleMatches: ReplaceInFilesMatch[];
}

export function registerreplaceInFilesModelEditing4Cases(caseContext: registerreplaceInFilesModelEditing4CasesContext) {

  describe("ED-REPAIR-005: replace prepare request identity on snapshot", () => {
    it("attaches frozen ReplacePrepareRequestIdentity to ReplacePreviewSnapshot (ED-REPAIR-005-A3)", () => {
      const scopeIdentity: ReplaceScopeIdentity = {
        kind: "all",
        roots: ["/ws/repo"],
        explicitFiles: [],
        fileMask: null,
        generation: null,
      };
      const queryIdentity = {
        query: "oldName",
        caseSensitive: false,
        wholeWord: false,
        regexp: false,
        includeGlobs: [],
        excludeGlobs: [],
      };
      const matchKeys = caseContext.sampleMatches.map(replaceMatchStableKey);
      const identity: ReplacePrepareRequestIdentity = {
        token: 42,
        workspaceInstanceId: "ws-instance-123",
        scope: scopeIdentity,
        query: queryIdentity,
        replacement: "newName",
        matchCount: 3,
        matchKeys,
        preparedAt: 123456789,
      };

      const snapshot: ReplacePreviewSnapshot = {
        scope: scopeIdentity,
        query: queryIdentity,
        replacement: "newName",
        matchKeys,
        matchCount: 3,
        editSignature: "sig-123",
        capturedAt: 123456789,
        preimages: [],
        requestIdentity: identity,
      };

      expect(snapshot.requestIdentity?.token).toBe(42);
      expect(snapshot.requestIdentity?.workspaceInstanceId).toBe("ws-instance-123");
      expect(snapshot.requestIdentity?.matchCount).toBe(3);
      expect(snapshot.requestIdentity?.matchKeys).toHaveLength(3);
      expect(snapshot.requestIdentity?.query.query).toBe("oldName");
      expect(snapshot.requestIdentity?.replacement).toBe("newName");
    });

    it("collects preimages successfully for clean files within roots (ED-REPAIR-005-A1, A3)", async () => {
      const roots = [{ path: "/ws/repo" }];
      const openBuffers: Record<string, { documentRevision: number | null; dirty: boolean; readOnly?: boolean; }> = {
        "/ws/repo/src/FileA.ts": { documentRevision: 5, dirty: false },
      };
      const files: Record<string, { text: string; hash: string; }> = {
        "src/FileA.ts": { text: "line 1\r\nline 2", hash: "hash-a" },
        "src/FileB.ts": { text: "line 1\nline 2", hash: "hash-b" },
      };

      const preimages = await collectReplacePreimages({
        paths: ["/ws/repo/src/FileA.ts", "/ws/repo/src/FileB.ts"],
        initialWorkspaceInstanceId: "ws-1",
        getCurrentWorkspaceInstanceId: () => "ws-1",
        getCurrentRoots: () => roots,
        getOpenFileState: (path) => openBuffers[path] ?? null,
        readFile: async (_root, rel) => files[rel]!,
      });

      expect(preimages).toHaveLength(2);
      expect(preimages[0]?.path).toBe("/ws/repo/src/FileA.ts");
      expect(preimages[0]?.textHash).toBe("hash-a");
      expect(preimages[0]?.eol).toBe("crlf");
      expect(preimages[0]?.bufferRevision).toBe(5);
      expect(preimages[0]?.dirty).toBe(false);
      expect(preimages[1]?.path).toBe("/ws/repo/src/FileB.ts");
      expect(preimages[1]?.textHash).toBe("hash-b");
      expect(preimages[1]?.eol).toBe("lf");
      expect(preimages[1]?.bufferRevision).toBeNull();
    });

    it("aborts immediately when signal is already aborted (ED-REPAIR-005-A1)", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          options: { signal: controller.signal },
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => "ws-1",
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => null,
          readFile: async () => ({ text: "", hash: "" }),
        }),
      ).rejects.toThrow("Replace preview cancelled");
    });

    it("aborts when signal fires during async disk read (ED-REPAIR-005-A1)", async () => {
      const controller = new AbortController();

      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          options: { signal: controller.signal },
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => "ws-1",
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => null,
          readFile: async () => {
            controller.abort();
            return { text: "hello", hash: "hash-1" };
          },
        }),
      ).rejects.toThrow("Replace preview cancelled");
    });

    it("refuses when options workspaceInstanceId mismatches initial (ED-REPAIR-005-A2)", async () => {
      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          options: { workspaceInstanceId: "ws-old" },
          initialWorkspaceInstanceId: "ws-current",
          getCurrentWorkspaceInstanceId: () => "ws-current",
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => null,
          readFile: async () => ({ text: "", hash: "" }),
        }),
      ).rejects.toThrow("Replace preview refused: workspace instance mismatch");
    });

    it("aborts when workspace changes during prepare (ED-REPAIR-005-A2)", async () => {
      let currentWs = "ws-1";

      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => currentWs,
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => null,
          readFile: async () => {
            currentWs = "ws-2"; // Workspace switch occurred during read
            return { text: "hello", hash: "hash-1" };
          },
        }),
      ).rejects.toThrow("Replace preview cancelled: workspace changed during prepare");
    });

    it("refuses when buffer documentRevision is modified during prepare (ED-REPAIR-005-A2)", async () => {
      let revision = 10;

      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => "ws-1",
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => ({ documentRevision: revision, dirty: false }),
          readFile: async () => {
            revision = 11; // User edited document during prepare read
            return { text: "hello", hash: "hash-1" };
          },
        }),
      ).rejects.toThrow(/modified during prepare; please retry/);
    });

    it("refuses when buffer dirty state changes during prepare (ED-REPAIR-005-A2)", async () => {
      let dirty = false;

      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => "ws-1",
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => ({ documentRevision: 10, dirty }),
          readFile: async () => {
            dirty = true; // Buffer marked dirty during prepare read
            return { text: "hello", hash: "hash-1" };
          },
        }),
      ).rejects.toThrow(/modified during prepare; please retry/);
    });

    it("aborts when roots change during prepare (ED-REPAIR-005-A2)", async () => {
      let roots = [{ path: "/ws/repo" }];

      await expect(
        collectReplacePreimages({
          paths: ["/ws/repo/src/FileA.ts"],
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => "ws-1",
          getCurrentRoots: () => roots,
          getOpenFileState: () => null,
          readFile: async () => {
            roots = [{ path: "/ws/other" }]; // Root configuration changed
            return { text: "hello", hash: "hash-1" };
          },
        }),
      ).rejects.toThrow("Replace preview cancelled: workspace state changed during prepare");
    });

    it("refuses when file path is outside roots (ED-REPAIR-005-A2)", async () => {
      await expect(
        collectReplacePreimages({
          paths: ["/outside/File.ts"],
          initialWorkspaceInstanceId: "ws-1",
          getCurrentWorkspaceInstanceId: () => "ws-1",
          getCurrentRoots: () => [{ path: "/ws/repo" }],
          getOpenFileState: () => null,
          readFile: async () => ({ text: "", hash: "" }),
        }),
      ).rejects.toThrow(/outside the workspace/);
    });
  });
}
