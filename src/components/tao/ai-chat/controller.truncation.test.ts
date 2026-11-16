import { expect, it, vi } from "vitest";
import { createChatController } from "./controller";
import type { TaoEvent } from "./ports";

function truncated(text = ""): TaoEvent[] {
  return [
    { type: "message_start" },
    { type: "block_start", index: 0, block: { type: "thinking", text: "Planning the implementation", status: "complete" } },
    { type: "block_start", index: 1, block: { type: "text", text } },
    { type: "block_delta", index: 1, delta: { text: "" } },
    { type: "message_delta", stopReason: "max_tokens" },
    { type: "message_stop" },
  ];
}

it("exposes thinking-only output exhaustion and retains it when history is restored", async () => {
  const controller = createChatController({ backend: { send: async () => truncated() } });
  await controller.send("Implement a project");
  const state = controller.getState();
  const thread = state.threads[state.activeThreadId!];
  expect(state.runtime[thread.id].phase).toBe("stopped");
  expect(thread.messages.at(-1)).toMatchObject({ stopReason: "max_tokens", text: "" });
  expect(thread.messages.at(-1)?.blocks[0].text).toBe("Planning the implementation");
  const restored = createChatController();
  restored.hydrateThreads([thread]);
  expect(restored.getState().runtime[thread.id].phase).toBe("stopped");
});

it("does not publish actions from truncated output and permits an explicit regeneration", async () => {
  const action = '```tao-action\n{"id":"write","kind":"write_file","title":"Write","payload":{"path":"app.py","content":"partial"}}\n```';
  const execute = vi.fn();
  const regenerate = vi.fn(async () => [
    { type: "message_start" },
    { type: "block_start", index: 0, block: { type: "text" } },
    { type: "block_delta", index: 0, delta: { text: "Complete response" } },
    { type: "message_delta", stopReason: "end_turn" },
    { type: "message_stop" },
  ] as TaoEvent[]);
  const controller = createChatController({ backend: { send: async () => truncated(action), regenerate }, actionPorts: { execute } });
  controller.setMode("do");
  await controller.send("Implement a project");
  const id = controller.getState().activeThreadId!;
  expect(controller.getState().runtime[id].phase).toBe("stopped");
  expect(controller.getState().threads[id].messages.at(-1)?.blocks.some((block) => block.action)).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  expect(await controller.regenerate()).toBe(true);
  expect(controller.getState().threads[id].messages.at(-1)).toMatchObject({ text: "Complete response", stopReason: "end_turn" });
  expect(controller.getState().runtime[id].phase).toBe("idle");
});
