import { describe, expect, it, vi } from "vitest";
import { MailMutationError, MailMutationSession } from "./mailMutations";
import type { MailMutationProgress } from "./mail";

function receipt(overrides: Partial<MailMutationProgress> = {}) {
  return { mutation: { operationId: "saved-job", completedUids: [1], pendingUids: [2, 3],
    uncertainUids: [], error: "Retry to continue", detail: "STORE rejected", retryable: true, batchSize: 1,
    ...overrides } };
}

describe("mail mutation continuation", () => {
  it("applies partial results once and reuses the saved operation when resuming", async () => {
    const task = new MailMutationSession();
    task.total = 3;
    const apply = vi.fn();
    const progress = vi.fn();
    const invoke = vi.fn().mockResolvedValueOnce(receipt()).mockResolvedValueOnce(receipt({
      completedUids: [1, 2, 3], pendingUids: [], error: null,
    }));
    await expect(task.execute("move", [1, 2, 3], invoke, apply, progress)).rejects.toThrow("Processed 1/3");
    await expect(task.execute("move", [1, 2, 3], invoke, apply, progress)).resolves.toBe(3);
    expect(invoke.mock.calls[1]).toEqual(["saved-job"]);
    expect(apply.mock.calls).toEqual([[[1]], [[2, 3]]]);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
    await task.execute("move", [1, 2, 3], invoke, apply, progress);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("retains the request identity after IPC failure and does not repeat completed batches", async () => {
    const task = new MailMutationSession();
    task.total = 2;
    const first = vi.fn().mockResolvedValue({});
    const second = vi.fn().mockRejectedValueOnce(new Error("IPC disconnected")).mockResolvedValue({});
    await task.execute("first", [1], first, () => {}, () => {});
    await expect(task.execute("second", [2], second, () => {}, () => {})).rejects.toThrow("IPC disconnected");
    await task.execute("first", [1], first, () => {}, () => {});
    await task.execute("second", [2], second, () => {}, () => {});
    expect(first).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][0]).toBe(second.mock.calls[1][0]);
    expect(task.completed).toBe(2);
  });

  it("exposes ambiguous server results as non-retryable and preserves uncompleted rows", async () => {
    const task = new MailMutationSession(); task.total = 3;
    const apply = vi.fn();
    try {
      await task.execute("copy", [1, 2, 3], async () => receipt({ completedUids: [], uncertainUids: [1, 2, 3], retryable: false }), apply, () => {});
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MailMutationError);
      expect((error as MailMutationError).retryable).toBe(false);
    }
    expect(apply).not.toHaveBeenCalled();
  });
});
