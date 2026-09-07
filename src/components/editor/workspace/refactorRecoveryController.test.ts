import { describe, expect, it } from "vitest";
import {
  getRefactorRecoveryJournal,
  type RefactorRecoveryJournalEntry,
  type RefactorRecoveryJournalEntryV1,
} from "./refactorPlan";
import { RefactorRecoveryController } from "./refactorRecoveryController";

function storageThatFailsWrites(): Storage {
  return {
    getItem: () => null,
    setItem: () => { throw new Error("quota exceeded"); },
    removeItem: () => undefined,
    key: () => null,
    length: 0,
    clear: () => undefined,
  };
}

function storageWithMap(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; },
    clear: () => { values.clear(); },
  };
}

function entry(overrides: Partial<RefactorRecoveryJournalEntry> = {}): RefactorRecoveryJournalEntry {
  return {
    schemaVersion: 2,
    workspaceId: "ws",
    recoveryId: "recovery-1",
    transactionId: "tx-1",
    actionId: "rename:Example",
    kind: "rename",
    workspaceRoot: "/repo",
    createdAt: 1,
    updatedAt: 1,
    status: "prepared",
    appliedOperationIndex: 0,
    operationCount: 1,
    documents: [{
      uri: "file:///repo/Example.java",
      canonicalPath: "/repo/Example.java",
      preText: "class Example {}",
      preHash: "pre-hash",
      postText: "class Renamed {}",
      postHash: "post-hash",
      encoding: "UTF-8",
      bom: false,
      eol: "lf",
      preDocumentRevision: 1,
    }],
    ...overrides,
  };
}

describe("RefactorRecoveryController", () => {
  it("does not write when the prepared journal cannot be persisted", async () => {
    const writes: string[] = [];
    const controller = new RefactorRecoveryController({
      workspaceId: "ws",
      workspaceRoot: "/repo",
      storage: storageThatFailsWrites(),
    });

    const result = await controller.recover(entry(), {
      readText: async () => ({ text: "class Renamed {}", hash: "post-hash", dirty: false }),
      applyText: async () => { writes.push("write"); },
    });

    expect(result.status).toBe("pending");
    expect(result.preHashesRestored).toBe(false);
    expect(writes).toEqual([]);
    if (result.status === "pending") expect(result.reason).toContain("quota exceeded");
  });

  it("reads all files before rejecting a third-party conflict", async () => {
    const writes: string[] = [];
    const controller = new RefactorRecoveryController({
      workspaceId: "ws",
      workspaceRoot: "/repo",
      storage: storageWithMap(),
    });

    const result = await controller.recover(entry(), {
      readText: async () => ({ text: "class SomeoneElse {}", hash: "foreign-hash", dirty: false }),
      applyText: async () => { writes.push("write"); },
    });

    expect(result.status).toBe("pending");
    expect(result.conflicts[0]).toContain("differs from both known recovery images");
    expect(writes).toEqual([]);
  });

  it("rechecks each file before writing so a mid-recovery third-party edit is not overwritten", async () => {
    let readCount = 0;
    const writes: string[] = [];
    const controller = new RefactorRecoveryController({
      workspaceId: "ws",
      workspaceRoot: "/repo",
      storage: storageWithMap(),
    });

    const result = await controller.recover(entry(), {
      readText: async () => {
        readCount += 1;
        if (readCount === 1) return { text: "class Renamed {}", hash: "post-hash", dirty: false };
        return { text: "class ThirdParty {}", hash: "foreign-hash", dirty: false };
      },
      applyText: async () => { writes.push("write"); },
    });

    expect(result.status).toBe("pending");
    expect(result.conflicts[0]).toContain("differs from both known recovery images");
    expect(writes).toEqual([]);
  });

  it("restores only post-image files, verifies each pre-image independently, and is idempotent", async () => {
    let currentText = "class Renamed {}";
    const writes: string[] = [];
    const controller = new RefactorRecoveryController({
      workspaceId: "ws",
      workspaceRoot: "/repo",
      storage: storageWithMap(),
    });
    const handlers = {
      readText: async () => ({
        text: currentText,
        hash: currentText === "class Example {}" ? "pre-hash" : "post-hash",
        dirty: false,
      }),
      applyText: async (_path: string, text: string) => {
        writes.push(text);
        currentText = text;
      },
    };

    const first = await controller.recover(entry(), handlers);
    const second = await controller.recover(entry(), handlers);

    expect(first.status).toBe("rolled-back");
    expect(first.preHashesRestored).toBe(true);
    expect(first.restoredUris).toEqual(["file:///repo/Example.java"]);
    expect(second.status).toBe("rolled-back");
    expect(second.preHashesRestored).toBe(true);
    expect(second.restoredUris).toEqual([]);
    expect(writes).toEqual(["class Example {}"]);
  });

  it("keeps a failed write pending and never replays a legacy v1 journal", async () => {
    const controller = new RefactorRecoveryController({
      workspaceId: "ws",
      workspaceRoot: "/repo",
      storage: storageWithMap(),
    });
    const failed = await controller.recover(entry(), {
      readText: async () => ({ text: "class Renamed {}", hash: "post-hash", dirty: false }),
      applyText: async () => { throw new Error("disk is locked"); },
    });
    const legacy: RefactorRecoveryJournalEntryV1 = {
      schemaVersion: 1,
      verified: false,
      recoveryId: "legacy-1",
      actionId: "legacy-rename",
      kind: "rename",
      workspaceRoot: "/repo",
      createdAt: 1,
      status: "prepared",
      documents: [{
        uri: "file:///repo/Example.java",
        canonicalPath: "/repo/Example.java",
        preText: "class Example {}",
        preHash: "pre-hash",
        postText: "class Renamed {}",
        postHash: "post-hash",
      }],
    };
    const writes: string[] = [];
    const unverified = await controller.recover(legacy, {
      readText: async () => ({ text: "class Renamed {}", hash: "post-hash", dirty: false }),
      applyText: async () => { writes.push("write"); },
    });

    expect(failed.status).toBe("pending");
    expect(failed.restoredUris).toEqual([]);
    if (failed.status === "pending") expect(failed.reason).toContain("disk is locked");
    expect(unverified.status).toBe("unverified");
    if (unverified.status === "unverified") expect(unverified.reason).toContain("v1");
    expect(writes).toEqual([]);
  });

  it("persists the recovered prefix when a later file fails", async () => {
    const first = entry();
    const twoFiles = entry({
      appliedOperationIndex: -1,
      operationCount: 2,
      documents: [
        first.documents[0]!,
        {
          ...first.documents[0]!,
          uri: "file:///repo/Other.java",
          canonicalPath: "/repo/Other.java",
          preText: "class Other {}",
          preHash: "other-pre-hash",
          postText: "class OtherRenamed {}",
          postHash: "other-post-hash",
        },
      ],
    });
    const storage = storageWithMap();
    const current = new Map([
      ["/repo/Example.java", "class Renamed {}"],
      ["/repo/Other.java", "class OtherRenamed {}"],
    ]);
    let failSecondWrite = true;
    const writes: string[] = [];
    const controller = new RefactorRecoveryController({
      workspaceId: "ws",
      workspaceRoot: "/repo",
      storage,
    });
    const handlers = {
      readText: async (path: string) => {
        const text = current.get(path);
        if (text === undefined) return null;
        const isOther = path.endsWith("Other.java");
        return {
          text,
          hash: isOther
            ? (text.includes("Renamed") ? "other-post-hash" : "other-pre-hash")
            : (text.includes("Renamed") ? "post-hash" : "pre-hash"),
          dirty: false,
        };
      },
      applyText: async (path: string, text: string) => {
        if (path.endsWith("Other.java") && failSecondWrite) throw new Error("second file is locked");
        writes.push(path);
        current.set(path, text);
      },
    };

    const failed = await controller.recover(twoFiles, handlers);

    expect(failed.status).toBe("pending");
    expect(failed.restoredUris).toEqual(["file:///repo/Example.java"]);
    const pending = getRefactorRecoveryJournal(twoFiles.recoveryId, storage);
    expect(pending).toMatchObject({
      status: "recovery-required",
      appliedOperationIndex: 0,
    });

    failSecondWrite = false;
    const recovered = await controller.recover(pending!, handlers);
    expect(recovered.status).toBe("rolled-back");
    expect(recovered.preHashesRestored).toBe(true);
    expect(writes).toEqual(["/repo/Example.java", "/repo/Other.java"]);
  });

  it("does not overwrite an open buffer whose revision changes between reads", async () => {
    let readCount = 0;
    const writes: string[] = [];
    const controller = new RefactorRecoveryController({
      workspaceId: "ws",
      workspaceRoot: "/repo",
      storage: storageWithMap(),
    });

    const result = await controller.recover(entry(), {
      readText: async () => {
        readCount += 1;
        return {
          text: "class Renamed {}",
          hash: "post-hash",
          dirty: false,
          documentRevision: readCount === 1 ? 2 : 3,
        };
      },
      applyText: async () => { writes.push("write"); },
    });

    expect(result.status).toBe("pending");
    expect(result.conflicts[0]).toContain("document revision changed");
    expect(writes).toEqual([]);
  });
});
