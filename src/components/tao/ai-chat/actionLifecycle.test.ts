import { describe, expect, it, vi } from "vitest";
import { createChatController } from "./controller";
import type { ActionProposal, TaoEvent, TaoRequest } from "./ports";

const proposal = { id: "same-model-id", kind: "write_file", title: "Implement", level: "L1", payload: { path: "main.py", content: "code" } } as const;
function response(): TaoEvent[] {
  return [{ type: "message_start" }, { type: "block_start", index: 0, block: { type: "text" } }, { type: "block_delta", index: 0, delta: { text: `Plan\n\`\`\`tao-action\n${JSON.stringify(proposal)}\n\`\`\`` } }, { type: "message_stop" }];
}
const current = (c: ReturnType<typeof createChatController>) => c.getState().threads[c.getState().activeThreadId!];
const proposed = (c: ReturnType<typeof createChatController>) => current(c).messages.at(-1)!.blocks.find((b) => b.action)!.action!;

describe("development action lifecycle", () => {
  it("closes development, failed tests, repair and feature rounds with unique executions", async () => {
    const requests: TaoRequest[] = [];
    const execute = vi.fn(async (_a: ActionProposal) => ({ exitCode: execute.mock.calls.length === 2 ? 1 : 0, output: execute.mock.calls.length === 2 ? "test failed" : "test passed", undoAvailable: true }));
    const controller = createChatController({ backend: { send: async (r) => { requests.push(r); return response(); } }, actionPorts: { execute } });
    controller.setMode("do"); controller.setContext({ workspace: "/qa/project" });
    const ids = new Set<string>();
    for (const prompt of ["Develop", "Test the implementation", "Repair using the failure", "Add a feature and test"]) {
      expect(await controller.send(prompt)).toBe(true);
      const action = proposed(controller); ids.add(action.executionId!);
      expect(await controller.regenerate()).toBe(false);
      await controller.approveAction(action);
      expect(controller.getState().runtime[current(controller).id].phase).toBe("idle");
    }
    expect(ids.size).toBe(4);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(requests[2].actionFeedback).toEqual(expect.arrayContaining([expect.objectContaining({ status: "invalid", result: expect.objectContaining({ exitCode: 1, output: "test failed" }) })]));
  });

  it("owns late results and older undo by source message while another thread is active", async () => {
    let finish!: (result: ActionProposal["result"]) => void;
    const undo = vi.fn(async () => {});
    const controller = createChatController({ backend: { send: async () => response() }, actionPorts: { execute: () => new Promise((resolve) => { finish = resolve; }), undo } });
    controller.setMode("do"); controller.setContext({ workspace: "/qa/project" }); await controller.send("Implement");
    const first = current(controller).id, action = proposed(controller);
    const pending = controller.approveAction(action);
    const other = controller.createThread();
    finish({ exitCode: 0, undoAvailable: true, actionId: "native-first" }); await pending;
    expect(current(controller).messages).toHaveLength(0);
    expect(controller.getState().activeThreadId).toBe(other);
    controller.setActiveThread(first);
    await controller.send("Add a feature"); await controller.rejectAction(proposed(controller));
    await controller.undoAction(action);
    expect(current(controller).messages[1].blocks.find((b) => b.action)?.action?.status).toBe("undone");
    expect(proposed(controller).status).toBe("rejected");
    expect(undo).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ actionId: "native-first" }) }), first);
  });

  it("recovers pending approvals after restart and marks interrupted execution for review", async () => {
    const controller = createChatController({ backend: { send: async () => response() } });
    controller.setMode("do"); controller.setContext({ workspace: "/qa/project" }); await controller.send("Implement");
    const saved = structuredClone(current(controller));
    const restored = createChatController({ backend: { send: async () => response() } }); restored.hydrateThreads([saved]);
    expect(await restored.send("Must resolve pending action")).toBe(false);
    await restored.approveAction(proposed(restored));
    expect(proposed(restored).status).toBe("invalid");
    expect(await restored.send("Try again")).toBe(true);
    saved.messages[1].blocks.find((b) => b.action)!.action!.status = "approved";
    restored.hydrateThreads([saved]);
    expect(proposed(restored).status).toBe("invalid");
    expect(proposed(restored).result?.output).toMatch(/interrupted|中断/);
  });
});
