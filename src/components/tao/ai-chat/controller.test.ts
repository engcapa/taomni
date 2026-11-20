import { describe, expect, it, vi } from "vitest";
import { createChatController } from "./controller";
import type { ChatBackend, TaoEvent } from "./ports";

const profile = { defaultModel: "deepseek-flash" as const, defaultThinking: false, defaultWeb: false, modes: [], sidePanels: [] };

function answer(text: string): TaoEvent[] {
  return [
    { type: "message_start" },
    { type: "block_start", index: 0, block: { type: "text", status: "running" } },
    { type: "block_delta", index: 0, delta: { text } },
    { type: "block_stop", index: 0 },
    { type: "message_delta", stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 3 } },
    { type: "message_stop" },
  ];
}

describe("Tao chat controller", () => {
  it("keeps two host instances isolated and preserves ordered blocks", async () => {
    const backend: ChatBackend = { send: vi.fn<ChatBackend["send"]>(async () => answer("hello")) };
    const first = createChatController({ backend, profile });
    const second = createChatController({ backend, profile });
    first.setComposerText("question");
    await first.send();
    const firstThread = first.getState().threads[first.getState().activeThreadId!];
    expect(firstThread.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(firstThread.messages[1].text).toBe("hello");
    expect(first.getState().runtime[first.getState().activeThreadId!].budget.usedTokens).toBe(5);
    expect(second.getState().threads[second.getState().activeThreadId!].messages).toHaveLength(0);
  });

  it("discards text on refusal and exposes an action confirmation phase", async () => {
    const refusal: ChatBackend = { send: vi.fn<ChatBackend["send"]>(async () => [
      { type: "message_start" },
      { type: "block_start", index: 0, block: { type: "thinking", status: "running" } },
      { type: "block_delta", index: 0, delta: { text: "private reasoning" } },
      { type: "message_delta", stopReason: "refusal" },
      { type: "message_stop" },
    ]) };
    const refused = createChatController({ backend: refusal, profile });
    await refused.send("unsafe");
    const refusedThread = refused.getState().threads[refused.getState().activeThreadId!];
    expect(refused.getState().runtime[refusedThread.id].phase).toBe("refusal");
    expect(refusedThread.messages[1].text).toBe("");
    expect(refusedThread.messages[1].blocks[0].error?.message).toContain("安全校验");

    const actionText = ["先说明", "```tao-action", JSON.stringify({ id: "a1", kind: "run_command", title: "查看", payload: { command: "ls" } }), "```"].join("\n");
    const actions: ChatBackend = { send: vi.fn<ChatBackend["send"]>(async () => answer(actionText)) };
    const withAction = createChatController({ backend: actions, profile });
    withAction.setMode("do");
    await withAction.send("do it");
    const actionState = withAction.getState();
    const actionThread = actionState.threads[actionState.activeThreadId!];
    expect(actionState.runtime[actionThread.id].phase).toBe("awaiting_action");
    expect(actionThread.messages[1].blocks.some((block) => block.type === "action")).toBe(true);
  });

  it("stops an active request and prevents continuation of web replies", async () => {
    let release!: () => void;
    const backend: ChatBackend = {
      send: vi.fn<ChatBackend["send"]>(() => new Promise<Iterable<TaoEvent>>((resolve) => { release = () => resolve(answer("partial")); })),
      continue: vi.fn<NonNullable<ChatBackend["continue"]>>(async () => answer("continued")),
    };
    const controller = createChatController({ backend, profile });
    const pending = controller.send("long");
    await Promise.resolve();
    await controller.stop();
    expect(controller.getState().runtime[controller.getState().activeThreadId!].phase).toBe("stopped");
    release();
    await pending;
    expect(await controller.continueReply()).toBe(true);

    controller.setComposerOption("web", true);
    controller.setComposerText("web");
    const webBackend: ChatBackend = { send: vi.fn<ChatBackend["send"]>(async () => answer("web")), continue: vi.fn<NonNullable<ChatBackend["continue"]>>(async () => answer("again")) };
    const web = createChatController({ backend: webBackend, profile });
    web.setComposerOption("web", true);
    await web.send("web");
    expect(await web.continueReply()).toBe(false);
  });

  it("halts at the configured token budget without losing the partial answer", async () => {
    const backend: ChatBackend = { send: vi.fn<ChatBackend["send"]>(async () => [
      { type: "message_start" },
      { type: "block_start", index: 0, block: { type: "text" } },
      { type: "block_delta", index: 0, delta: { text: "partial" } },
      { type: "message_delta", usage: { inputTokens: 8, outputTokens: 3 } },
    ]) };
    const controller = createChatController({ backend, profile, budget: { limitTokens: 10 } });
    await controller.send("budget");
    const state = controller.getState();
    const thread = state.threads[state.activeThreadId!];
    expect(state.runtime[thread.id].phase).toBe("budget_halt");
    expect(thread.messages[1].text).toBe("partial");
  });

  it("deduplicates repeated usage events, accumulates message calls, and branches without mutating source", async () => {
    let call = 0;
    const backend: ChatBackend = { send: vi.fn<ChatBackend["send"]>(async () => {
      call += 1;
      return call === 1 ? [
        { type: "message_start", messageId: "turn-1" },
        { type: "block_start", index: 0, block: { type: "text" } },
        { type: "block_delta", index: 0, delta: { text: "first" } },
        { type: "message_delta", usage: { inputTokens: 2, outputTokens: 3 } },
        { type: "message_delta", usage: { inputTokens: 2, outputTokens: 3 } },
        { type: "message_stop" },
      ] : answer("second");
    }) };
    const controller = createChatController({ backend, profile });
    await controller.send("prompt");
    const source = controller.getState().threads[controller.getState().activeThreadId!];
    expect(controller.getState().runtime[source.id].budget.usedTokens).toBe(5);
    const branched = controller.branchAt(source.messages[0].id, "edited");
    expect(branched).toBeTruthy();
    const branch = controller.getState().threads[branched!];
    expect(branch.messages).toHaveLength(0);
    expect(controller.getState().composer.text).toBe("edited");
    expect(source.messages).toHaveLength(2);
  });
});
