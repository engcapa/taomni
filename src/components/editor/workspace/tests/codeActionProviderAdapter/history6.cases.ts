import { describe, expect, it, vi } from "vitest";
import { CanonicalCodeActionService, extractAffectedResourcesFromWorkspaceEdit, type ImmutableCodeActionPlan } from "../../codeActionProviderAdapter";

export function registercodeActionProviderAdapterHistory6Cases() {

  describe("§ED-ACTION-004: Preview, Commit, Postcondition, and History", () => {
    const service = new CanonicalCodeActionService();

    const samplePlan: ImmutableCodeActionPlan = {
      actionId: "action-multi-rename-1",
      title: "Rename Symbol Across Files",
      kind: "refactor.rename",
      document: {
        uri: "file:///workspace/src/Service.java",
        revision: 3,
        languageId: "java",
      },
      provider: {
        id: "jdtls",
        version: "1.61.0",
        generation: 2,
        projectFingerprint: "fp-test-4",
        trusted: true,
      },
      edit: {
        documentEdits: [
          {
            uri: "file:///workspace/src/Service.java",
            path: "/workspace/src/Service.java",
            edits: [{ range: { start: { line: 1, character: 5 }, end: { line: 1, character: 15 } }, newText: "NewService" }],
          },
          {
            uri: "file:///workspace/src/Client.java",
            path: "/workspace/src/Client.java",
            edits: [{ range: { start: { line: 4, character: 10 }, end: { line: 4, character: 20 } }, newText: "NewService" }],
          },
        ],
      },
      command: {
        command: "java.action.logRename",
        arguments: ["Service", "NewService"],
      },
      evidence: null,
      createdAt: Date.now(),
    };

    const memorySnapshotHooks = (liveFiles: Record<string, string>) => ({
      captureSnapshot: async (edit: NonNullable<ImmutableCodeActionPlan["edit"]>) => ({
        resources: extractAffectedResourcesFromWorkspaceEdit(edit).map((resource) => ({
          uri: resource.uri,
          path: resource.path ?? resource.uri,
          exists: Object.hasOwn(liveFiles, resource.uri),
          text: liveFiles[resource.uri] ?? null,
        })),
      }),
      restoreSnapshot: async (snapshot: {
        resources: readonly { uri: string; exists: boolean; text: string | null; }[];
      }) => {
        for (const resource of snapshot.resources) {
          if (resource.exists && resource.text !== null) liveFiles[resource.uri] = resource.text;
          else delete liveFiles[resource.uri];
        }
      },
    });

    it("previews multi-file edits, computes pre-hashes, and flags confirmation", () => {
      const liveFiles: Record<string, string> = {
        "file:///workspace/src/Service.java": "class OldService {}",
        "file:///workspace/src/Client.java": "new OldService();",
      };

      const preview = service.previewPlan(samplePlan, {
        getLiveDocumentText: (uri) => liveFiles[uri] ?? null,
      });

      expect(preview.affectedUris).toEqual([
        "file:///workspace/src/Service.java",
        "file:///workspace/src/Client.java",
      ]);
      expect(preview.requiresConfirmation).toBe(true);
      expect(preview.preHashes["file:///workspace/src/Service.java"]).toBeDefined();
      expect(preview.preHashes["file:///workspace/src/Client.java"]).toBeDefined();
    });

    it("applies multi-file edit, returns history/recovery IDs, and records pre/post/undo hashes", async () => {
      const liveFiles: Record<string, string> = {
        "file:///workspace/src/Service.java": "class OldService {}",
        "file:///workspace/src/Client.java": "new OldService();",
      };

      let registeredHistory: { id: string; label: string; affectedUris: string[]; } | null = null;
      let executedCommandName: string | null = null;

      const outcome = await service.applyPlan(samplePlan, {
        getLiveDocumentText: (uri) => liveFiles[uri] ?? null,
        getLiveDocumentRevision: (uri) => (uri === "file:///workspace/src/Service.java" ? 3 : null),
        ...memorySnapshotHooks(liveFiles),
        applyWorkspaceEdit: async (_edit, options) => {
          await options?.onBeforeCommit?.();
          liveFiles["file:///workspace/src/Service.java"] = "class NewService {}";
          liveFiles["file:///workspace/src/Client.java"] = "new NewService();";
          return [
            { operationIndex: 0, path: "/workspace/src/Service.java", status: "applied-open", dirty: true },
            { operationIndex: 1, path: "/workspace/src/Client.java", status: "applied-disk" },
          ];
        },
        executeCommand: async (cmd) => {
          executedCommandName = cmd;
        },
        registerHistoryEntry: (entry) => {
          registeredHistory = entry;
        },
      });

      expect(outcome.status).toBe("applied");
      if (outcome.status === "applied") {
        expect(outcome.historyId).toMatch(/^ca-hist-/);
        expect(outcome.recoveryId).toBeNull();
        expect(outcome.affectedUris).toHaveLength(2);
        expect(executedCommandName).toBe("java.action.logRename");
        expect(registeredHistory).not.toBeNull();
        expect((registeredHistory as { id: string; } | null)?.id).toBe(outcome.historyId);

        // Pre/post/undo hash validation
        const serviceHash = outcome.uriHashes["file:///workspace/src/Service.java"]!;
        expect(serviceHash.preHash).not.toBe(serviceHash.postHash);
        expect(serviceHash.undoHash).toBe(serviceHash.preHash);

        const clientHash = outcome.uriHashes["file:///workspace/src/Client.java"]!;
        expect(clientHash.preHash).not.toBe(clientHash.postHash);
        expect(clientHash.undoHash).toBe(clientHash.preHash);
      }
    });

    it("replays the canonical history entry across every affected resource", async () => {
      const before = {
        "file:///workspace/src/Service.java": "class OldService {}",
        "file:///workspace/src/Client.java": "new OldService();",
      };
      const after = {
        "file:///workspace/src/Service.java": "class NewService {}",
        "file:///workspace/src/Client.java": "new NewService();",
      };
      const liveFiles: Record<string, string> = { ...before };
      let registeredHistory: {
        undo: () => Promise<void>;
        redo: () => Promise<void>;
      } | null = null;

      const outcome = await service.applyPlan(samplePlan, {
        getLiveDocumentText: (uri) => liveFiles[uri] ?? null,
        getLiveDocumentRevision: () => 3,
        ...memorySnapshotHooks(liveFiles),
        applyWorkspaceEdit: async (_edit, options) => {
          await options?.onBeforeCommit?.();
          Object.assign(liveFiles, after);
          return [
            { operationIndex: 0, path: "/workspace/src/Service.java", status: "applied-open", dirty: true },
            { operationIndex: 1, path: "/workspace/src/Client.java", status: "applied-open", dirty: true },
          ];
        },
        registerHistoryEntry: (entry) => {
          registeredHistory = entry;
        },
      });

      expect(outcome.status).toBe("applied");
      expect(registeredHistory).not.toBeNull();
      await registeredHistory!.undo();
      expect(liveFiles).toEqual(before);
      await registeredHistory!.redo();
      expect(liveFiles).toEqual(after);
    });

    it("rejects a preimage conflict after preview with zero edit and zero history", async () => {
      const liveFiles: Record<string, string> = {
        "file:///workspace/src/Service.java": "class OldService {}",
        "file:///workspace/src/Client.java": "new OldService();",
      };
      const applyMutation = vi.fn();
      const registerHistoryEntry = vi.fn();

      const outcome = await service.applyPlan(samplePlan, {
        getLiveDocumentText: (uri) => liveFiles[uri] ?? null,
        getLiveDocumentRevision: () => 3,
        ...memorySnapshotHooks(liveFiles),
        applyWorkspaceEdit: async (_edit, options) => {
          liveFiles["file:///workspace/src/Client.java"] = "new ConcurrentService();";
          try {
            await options?.onBeforeCommit?.();
          } catch (error) {
            return [{
              operationIndex: null,
              path: "WorkspaceEdit",
              status: "failed" as const,
              reason: error instanceof Error ? error.message : String(error),
            }];
          }
          applyMutation();
          return [];
        },
        registerHistoryEntry,
      });

      expect(outcome.status).toBe("conflict");
      expect(applyMutation).not.toHaveBeenCalled();
      expect(registerHistoryEntry).not.toHaveBeenCalled();
      expect(liveFiles["file:///workspace/src/Service.java"]).toBe("class OldService {}");
    });

    it("restores all preimages after a partial commit failure and returns a performed recovery id", async () => {
      const before: Record<string, string> = {
        "file:///workspace/src/Service.java": "class OldService {}",
        "file:///workspace/src/Client.java": "new OldService();",
      };
      const liveFiles = { ...before };
      const registerHistoryEntry = vi.fn();

      const outcome = await service.applyPlan(samplePlan, {
        getLiveDocumentText: (uri) => liveFiles[uri] ?? null,
        getLiveDocumentRevision: () => 3,
        ...memorySnapshotHooks(liveFiles),
        applyWorkspaceEdit: async (_edit, options) => {
          await options?.onBeforeCommit?.();
          liveFiles["file:///workspace/src/Service.java"] = "class NewService {}";
          return [
            { operationIndex: 0, path: "/workspace/src/Service.java", status: "applied-open", dirty: true },
            { operationIndex: 1, path: "/workspace/src/Client.java", status: "failed", reason: "disk conflict" },
          ];
        },
        registerHistoryEntry,
      });

      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.recoveryId).toMatch(/^ca-rec-/);
        expect(outcome.recoveryState).toBe("performed");
      }
      expect(liveFiles).toEqual(before);
      expect(registerHistoryEntry).not.toHaveBeenCalled();
    });

    it("detects live owner document revision changes before commit and rejects with stale", async () => {
      const liveFiles: Record<string, string> = {
        "file:///workspace/src/Service.java": "class OldService {}",
      };

      const outcome = await service.applyPlan(samplePlan, {
        getLiveDocumentText: (uri) => liveFiles[uri] ?? null,
        getLiveDocumentRevision: () => 4, // Live document moved from 3 -> 4!
        applyWorkspaceEdit: async () => [],
      });

      expect(outcome.status).toBe("stale");
      if (outcome.status === "stale") {
        expect(outcome.reason).toContain("Live document revision changed from 3 to 4");
      }
    });

    it("respects abort signal and cancels before commit with zero apply", async () => {
      const controller = new AbortController();
      controller.abort();

      const outcome = await service.applyPlan(samplePlan, {
        getLiveDocumentText: () => "",
        getLiveDocumentRevision: () => 3,
        applyWorkspaceEdit: async () => [],
      }, { signal: controller.signal });

      expect(outcome.status).toBe("cancelled");
    });

    it("surfaces provider command failures visibly without masking errors", async () => {
      const liveFiles: Record<string, string> = {
        "file:///workspace/src/Service.java": "text",
        "file:///workspace/src/Client.java": "text",
      };
      const outcome = await service.applyPlan(samplePlan, {
        getLiveDocumentText: (uri) => liveFiles[uri] ?? null,
        getLiveDocumentRevision: () => 3,
        ...memorySnapshotHooks(liveFiles),
        applyWorkspaceEdit: async (_edit, options) => {
          await options?.onBeforeCommit?.();
          return [{ operationIndex: 0, path: "/workspace/src/Service.java", status: "applied-open", dirty: true }];
        },
        executeCommand: async () => {
          throw new Error("LSP command execution timed out on language server");
        },
        registerHistoryEntry: vi.fn(),
      });

      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed") {
        expect(outcome.error).toContain("LSP command execution timed out on language server");
      }
    });
  });
}
