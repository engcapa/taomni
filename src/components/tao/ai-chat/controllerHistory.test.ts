import { expect, it } from "vitest";
import { createChatController } from "./controller";
import type { TaoEvent } from "./ports";

it("refreshes history without replacing an active streaming owner, content or runtime", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const controller = createChatController({ backend: { send: async () => (async function* (): AsyncGenerator<TaoEvent> {
    yield { type: "block_start", index: 0, block: { id: "text", type: "text", text: "" } };
    yield { type: "block_delta", index: 0, delta: { text: "Live answer" } };
    await pending;
    yield { type: "message_stop" };
  })() } });
  const id = controller.getState().activeThreadId!;
  const sending = controller.send("Question");
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const before = controller.getState();
  controller.hydrateThreads([{ id, title: "Stale disk", updatedAt: 1, messages: [] }, { id: "legacy", title: "Drawer", updatedAt: 1, messages: [], source: "legacy" }], { merge: true });
  expect(controller.getState().threads[id]).toBe(before.threads[id]);
  expect(controller.getState().runtime[id]).toBe(before.runtime[id]);
  expect(controller.getState().threads[id].running).toBe(true);
  controller.hydrateThreads([], { merge: true });
  expect(controller.getState().threads.legacy).toBeUndefined();
  expect(controller.getState().threads[id].running).toBe(true);
  finish(); await sending;
  expect(controller.getState().threads[id].messages.at(-1)?.text).toBe("Live answer");
});
