import { expect, it, vi } from "vitest";
import { createChatController } from "./controller";
import type { TaoEvent } from "./ports";

const events: TaoEvent[] = [{ type: "message_start" }, { type: "block_start", index: 0, block: { type: "text" } }, { type: "block_delta", index: 0, delta: { text: "A real adapter result" } }, { type: "message_stop" }];

it("retains ordinary provider/model across send, thread switches and restoration without enabling unsupported modes", async () => {
  const send = vi.fn(async () => events);
  const controller = createChatController({ backend: { send } });
  controller.setProvider("custom-anthropic", { model: "configured-v2", thinking: false, web: false });
  controller.setMode("research");
  controller.setComposerOption("thinking", true);
  controller.setChips([{ id: "doc", kind: "file", label: "doc", provider: "custom-anthropic", fileId: "inline-doc" }]);
  const first = controller.getState().activeThreadId!;
  await controller.send("Explain this document");
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ provider: "custom-anthropic", model: "configured-v2", thinking: false, web: false }), expect.any(AbortSignal));
  controller.createThread();
  controller.setActiveThread(first);
  expect(controller.getState().composer).toMatchObject({ provider: "custom-anthropic", model: "configured-v2", thinking: false, web: false });
  const restored = createChatController();
  restored.hydrateThreads(Object.values(controller.getState().threads));
  restored.setActiveThread(first);
  expect(restored.getState().composer).toMatchObject({ provider: "custom-anthropic", model: "configured-v2", capabilities: { thinking: false, web: false } });
  restored.setProvider("opencode-go", { model: "deepseek-v4.1-flash", thinking: true, web: true });
  expect(restored.getState().composer.chips).toHaveLength(0);
});
