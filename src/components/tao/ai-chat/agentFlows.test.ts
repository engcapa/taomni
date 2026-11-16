import { describe, expect, it, vi } from "vitest";
import { createChatController } from "./controller";
import type { ActionProposal, TaoEvent, TaoRequest } from "./ports";

function response(actions: ActionProposal[] = []): TaoEvent[] {
  const text = actions.length ? actions.map((a) => `\`\`\`tao-action\n${JSON.stringify(a)}\n\`\`\``).join("\n") : "A useful response";
  return [{ type: "message_start" }, { type: "block_start", index: 0, block: { type: "text" } }, { type: "block_delta", index: 0, delta: { text } }, { type: "message_stop" }];
}
const action = (id: string): ActionProposal => ({ id, kind: "run_command", title: "Run project tests", level: "L1", payload: { command: "python -m unittest" } });

describe("Tao agent workflow branches", () => {
  it.each(["ask", "research"] as const)("keeps %s read only even when a model emits action fences", async (mode) => {
    const execute = vi.fn();
    const controller = createChatController({ backend: { send: async () => response([action("test")]) }, actionPorts: { execute } });
    controller.setMode(mode);
    await controller.send("Explain the test failure");
    const state = controller.getState();
    expect(state.threads[state.activeThreadId!].messages.at(-1)?.blocks.some((b) => b.action)).toBe(false);
    expect(state.runtime[state.activeThreadId!].phase).toBe("idle");
    expect(execute).not.toHaveBeenCalled();
  });

  it("waits for every proposal, feeds failures/rejections back, and can request a repair", async () => {
    const requests: TaoRequest[] = [];
    const execute = vi.fn(async () => ({ exitCode: 1, output: "Tests failed", actionId: "native-test" }));
    const controller = createChatController({ backend: { send: async (request) => { requests.push(request); return requests.length === 1 ? response([action("test"), action("another")]) : response(); } }, actionPorts: { execute } });
    controller.setMode("do");
    await controller.send("Build and test a project");
    expect(await controller.send("Should wait")).toBe(false);
    const thread = () => controller.getState().threads[controller.getState().activeThreadId!];
    const proposals = thread().messages.at(-1)!.blocks.flatMap((b) => b.action ? [b.action] : []);
    await controller.approveAction(proposals[0]);
    expect(controller.getState().runtime[thread().id].phase).toBe("awaiting_action");
    await controller.rejectAction(proposals[1]);
    expect(controller.getState().runtime[thread().id].phase).toBe("idle");
    expect(await controller.send("Use the failure to repair the implementation")).toBe(true);
    expect(requests[1].actionFeedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: proposals[0].executionId, status: "invalid", result: expect.objectContaining({ exitCode: 1 }) }),
      expect.objectContaining({ id: proposals[1].executionId, status: "rejected" }),
    ]));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("recovers after executor rejection and prevents duplicate approvals", async () => {
    let reject!: (error: Error) => void;
    const execute = vi.fn(() => new Promise<never>((_, fail) => { reject = fail; }));
    const controller = createChatController({ backend: { send: async () => response([action("test")]) }, actionPorts: { execute } });
    controller.setMode("do"); await controller.send("Run tests");
    const proposed = controller.getState().threads[controller.getState().activeThreadId!].messages.at(-1)!.blocks.find((b) => b.action)!.action!;
    const pending = controller.approveAction(proposed);
    await controller.approveAction(proposed);
    expect(execute).toHaveBeenCalledTimes(1);
    reject(new Error("Process could not start")); await pending;
    const state = controller.getState();
    expect(state.runtime[state.activeThreadId!].phase).toBe("idle");
    expect(await controller.send("Try a different test command")).toBe(true);
  });

  it("persists Go/max per thread and never reuses another provider's attachments", async () => {
    const send = vi.fn(async (_request: TaoRequest) => response());
    const controller = createChatController({ backend: { send } });
    controller.setDefaults({ defaultModel: "deepseek-v4.1-flash", defaultProvider: "opencode-go", defaultReasoningEffort: "max", defaultThinking: true, defaultWeb: false });
    expect(controller.getState().composer).toMatchObject({ provider: "opencode-go", reasoningEffort: "max", thinking: true });
    const first = controller.getState().activeThreadId!;
    await controller.send("A complex task");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ provider: "opencode-go", model: "deepseek-v4.1-flash", reasoningEffort: "max", thinking: true }), expect.any(AbortSignal));
    controller.createThread(); controller.setProvider("deepseek-app");
    controller.setChips([{ id: "deepseek-file", kind: "file", label: "f", fileId: "f", provider: "deepseek-app" }]);
    controller.setProvider("opencode-go"); expect(controller.getState().composer.chips).toHaveLength(0);
    controller.setActiveThread(first);
    expect(controller.getState().composer).toMatchObject({ provider: "opencode-go", reasoningEffort: "max" });
    const restored = createChatController(); restored.hydrateThreads(Object.values(controller.getState().threads)); restored.setActiveThread(first);
    expect(restored.getState().composer).toMatchObject({ provider: "opencode-go", model: "deepseek-v4.1-flash", reasoningEffort: "max" });
  });
});
