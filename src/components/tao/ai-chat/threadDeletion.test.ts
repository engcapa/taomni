import { describe, expect, it, vi } from "vitest";
import { createChatController } from "./controller";

describe("Tao conversation deletion", () => {
  it("deletes the active thread, clears its runtime and restores the remaining draft", async () => {
    const controller = createChatController();
    const kept = controller.getState().activeThreadId!;
    controller.setComposerText("keep this draft");
    const removed = controller.createThread("remove this");
    const persist = vi.fn(async () => undefined);
    expect(await controller.deleteThread(removed, persist)).toBe(true);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ id: removed }));
    expect(controller.getState().threads[removed]).toBeUndefined();
    expect(controller.getState().runtime[removed]).toBeUndefined();
    expect(controller.getState().activeThreadId).toBe(kept);
    expect(controller.getState().composer.text).toBe("keep this draft");
  });

  it("creates a fresh usable conversation when the last Home thread is removed", async () => {
    const controller = createChatController();
    const removed = controller.getState().activeThreadId!;
    await controller.deleteThread(removed);
    const state = controller.getState();
    expect(state.activeThreadId).not.toBe(removed);
    expect(Object.keys(state.threads)).toEqual([state.activeThreadId]);
    expect(state.composer.text).toBe("");
    expect(state.runtime[state.activeThreadId!].phase).toBe("idle");
  });

  it("keeps another active conversation and draft when a historical row is removed", async () => {
    const controller = createChatController();
    const removed = controller.getState().activeThreadId!;
    const kept = controller.createThread();
    controller.setComposerText("unrelated draft");
    await controller.deleteThread(removed);
    expect(controller.getState().activeThreadId).toBe(kept);
    expect(controller.getState().composer.text).toBe("unrelated draft");
  });

  it("retains history on persistence failure and allows explicit retry", async () => {
    const controller = createChatController();
    const id = controller.getState().activeThreadId!;
    controller.setComposerText("valuable draft");
    await expect(controller.deleteThread(id, async () => { throw new Error("disk unavailable"); })).rejects.toThrow("disk unavailable");
    expect(controller.getState().threads[id]).toBeDefined();
    expect(controller.getState().composer.text).toBe("valuable draft");
    expect(controller.getState().runtime[id].deleting).toBe(false);
    expect(await controller.deleteThread(id)).toBe(true);
  });

  it("blocks duplicate deletion and paid sends while storage deletion is pending", async () => {
    const send = vi.fn(async () => []);
    const controller = createChatController({ backend: { send, continue: send, regenerate: send } });
    const id = controller.getState().activeThreadId!;
    let finish!: () => void;
    const deletion = controller.deleteThread(id, () => new Promise<void>((resolve) => { finish = resolve; }));
    controller.setComposerText("cannot send yet");
    expect(await controller.deleteThread(id)).toBe(false);
    expect(await controller.send()).toBe(false);
    expect(await controller.continueReply()).toBe(false);
    expect(await controller.regenerate()).toBe(false);
    expect(send).not.toHaveBeenCalled();
    finish();
    expect(await deletion).toBe(true);
    expect(controller.getState().threads[id]).toBeUndefined();
  });

  it("requires an active stream to finish or stop before deletion", async () => {
    let finish!: () => void;
    const controller = createChatController({ backend: { send: async () => (async function* () {
      yield { type: "message_start" as const };
      await new Promise<void>((resolve) => { finish = resolve; });
    })() } });
    const id = controller.getState().activeThreadId!;
    const request = controller.send("stream");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const persist = vi.fn(async () => undefined);
    expect(await controller.deleteThread(id, persist)).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    finish(); await request;
    expect(await controller.deleteThread(id, persist)).toBe(true);
  });
});
