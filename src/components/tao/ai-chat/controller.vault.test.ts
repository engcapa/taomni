import { describe, expect, it, vi } from "vitest";
import { createChatController } from "./controller";
import type { ChatBackend, TaoEvent } from "./ports";

function interrupted(): TaoEvent[] {
  return [
    { type: "message_start" },
    { type: "block_start", index: 0, block: { type: "text" } },
    { type: "block_delta", index: 0, delta: { text: "Retained partial answer" } },
    { type: "error", category: "vault_locked", message: "request cancelled" },
    { type: "message_stop" },
  ];
}

describe("Tao Vault interruption", () => {
  it("keeps the lock and partial answer after the native terminal event", async () => {
    const backend: ChatBackend = { send: vi.fn(async () => interrupted()) };
    const controller = createChatController({ backend });

    await controller.send("Slow response");

    const state = controller.getState();
    const thread = state.threads[state.activeThreadId!];
    expect(state.runtime[thread.id].phase).toBe("vault_locked");
    expect(state.runtime[thread.id].finishedAt).toBeTypeOf("number");
    expect(thread.running).toBe(false);
    expect(thread.messages[1].text).toBe("Retained partial answer");
    expect(thread.messages[1].blocks.filter((block) => block.type === "error")).toHaveLength(1);
  });

  it("classifies an IPC Vault rejection before the stream as a lock", async () => {
    const controller = createChatController({
      backend: { send: vi.fn(async () => { throw new Error("vault_locked: credential vault is locked"); }) },
    });
    await controller.send("Hello");
    const state = controller.getState();
    expect(state.runtime[state.activeThreadId!].phase).toBe("vault_locked");
    expect(state.threads[state.activeThreadId!].messages[1].blocks[0].error?.category).toBe("vault_locked");
  });

  it("blocks paid entry points until explicit unlock, then waits for manual continuation", async () => {
    const backend: ChatBackend = {
      send: vi.fn(async () => interrupted()),
      continue: vi.fn(async () => [
        { type: "message_start" },
        { type: "block_start", index: 0, block: { type: "text" } },
        { type: "block_delta", index: 0, delta: { text: " continued" } },
        { type: "message_stop" },
      ] as TaoEvent[]),
      regenerate: vi.fn(async () => []),
    };
    const controller = createChatController({ backend });
    await controller.send("Slow response");
    const id = controller.getState().activeThreadId!;
    controller.setComposerText("Next draft");
    expect(await controller.send()).toBe(false);
    expect(await controller.regenerate()).toBe(false);
    expect(await controller.continueReply()).toBe(false);
    expect(controller.getState().composer.text).toBe("Next draft");

    controller.acknowledgeVaultUnlock(id);
    expect(controller.getState().runtime[id].phase).toBe("stopped");
    expect(backend.send).toHaveBeenCalledTimes(1);
    expect(backend.continue).not.toHaveBeenCalled();
    expect(backend.regenerate).not.toHaveBeenCalled();

    expect(await controller.continueReply()).toBe(true);
    const reply = controller.getState().threads[id].messages[1];
    expect(reply.text).toBe("Retained partial answer continued");
    expect(reply.blocks).toHaveLength(2);
    expect(controller.getState().runtime[id].phase).toBe("idle");
  });

  it("unlocks the captured thread without changing the active draft", async () => {
    const controller = createChatController({ backend: { send: vi.fn(async () => interrupted()) } });
    await controller.send("Slow response");
    const locked = controller.getState().activeThreadId!;
    const active = controller.createThread("Other conversation");
    controller.setComposerText("Unrelated draft");
    controller.acknowledgeVaultUnlock(locked);
    expect(controller.getState().activeThreadId).toBe(active);
    expect(controller.getState().runtime[locked].phase).toBe("stopped");
    expect(controller.getState().runtime[active].phase).toBe("idle");
    expect(controller.getState().composer.text).toBe("Unrelated draft");
  });

  it("does not let a late Stop acknowledgement dismiss a Vault lock", async () => {
    let settleStop!: () => void;
    let finish!: () => void;
    const controller = createChatController({ backend: {
      send: async () => (async function* () {
        for (const event of interrupted()) yield event;
        await new Promise<void>((resolve) => { finish = resolve; });
      })(),
      stop: () => new Promise<void>((resolve) => { settleStop = resolve; }),
    } });
    const request = controller.send("Slow response");
    await vi.waitFor(() => expect(controller.getState().runtime[controller.getState().activeThreadId!].phase).toBe("vault_locked"));
    const stopped = controller.stop();
    settleStop();
    await stopped;
    finish();
    await request;
    expect(controller.getState().runtime[controller.getState().activeThreadId!].phase).toBe("vault_locked");
  });
});
