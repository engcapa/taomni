import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChatController, type TaoEvent, type TaoThread } from "../ai-chat";
import { nativeThreadStorage } from "../ai-chat/backend";
import { useThreadHistory } from "./useThreadHistory";

vi.mock("../../../lib/runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../ai-chat/backend", () => ({ nativeThreadStorage: { load: vi.fn(), save: vi.fn(), remove: vi.fn() } }));
const saved: TaoThread = { id: "saved", title: "Saved transcript", updatedAt: 1, messages: [{ id: "answer", role: "assistant", text: "Keep this answer", blocks: [], createdAt: 1 }] };
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); vi.mocked(nativeThreadStorage.load).mockResolvedValue([saved]); vi.mocked(nativeThreadStorage.save).mockResolvedValue(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

it("flushes a draft when Home unmounts before the autosave timer expires", async () => {
  const controller = createChatController();
  const hook = renderHook(() => useThreadHistory(controller));
  await settle();
  act(() => controller.setComposerText("Draft before immediate navigation"));
  hook.unmount(); await settle();
  expect(nativeThreadStorage.save).toHaveBeenCalledWith(expect.objectContaining({ id: "saved", preferences: expect.objectContaining({ composer: expect.objectContaining({ text: "Draft before immediate navigation" }) }) }));
});

it("merges a delayed disk load without replacing a conversation edited during loading", async () => {
  let resolve!: (threads: TaoThread[]) => void;
  vi.mocked(nativeThreadStorage.load).mockReturnValue(new Promise((done) => { resolve = done; }));
  const controller = createChatController();
  renderHook(() => useThreadHistory(controller));
  const active = controller.getState().activeThreadId!;
  act(() => controller.setComposerText("Keep my draft"));
  await act(async () => resolve([saved]));
  expect(controller.getState().activeThreadId).toBe(active);
  expect(controller.getState().composer.text).toBe("Keep my draft");
  expect(controller.getState().threads.saved.messages[0].text).toBe("Keep this answer");
});

it("persists while edits continue instead of postponing every save indefinitely", async () => {
  const controller = createChatController();
  renderHook(() => useThreadHistory(controller)); await settle();
  vi.mocked(nativeThreadStorage.save).mockClear();
  for (let index = 0; index < 12; index++) {
    act(() => controller.setComposerText(`stream ${index}`));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
  expect(nativeThreadStorage.save).toHaveBeenCalled();
});

it("retries a failed read and refreshes legacy summaries without resetting the active draft", async () => {
  vi.mocked(nativeThreadStorage.load).mockRejectedValueOnce(new Error("vault_locked")).mockResolvedValueOnce([saved])
    .mockResolvedValueOnce([saved, { id: "legacy", title: "New ChatDrawer history", messages: [], updatedAt: 2, source: "legacy" }]);
  const controller = createChatController();
  const hook = renderHook(() => useThreadHistory(controller)); await settle();
  expect(hook.result.current.error).toContain("vault_locked");
  act(() => hook.result.current.refresh()); await settle();
  expect(hook.result.current.error).toBe("");
  act(() => controller.setComposerText("Retain across refresh"));
  act(() => hook.result.current.refresh()); await settle();
  expect(controller.getState().threads.legacy.title).toBe("New ChatDrawer history");
  expect(controller.getState().composer.text).toBe("Retain across refresh");
});

it.each(["send", "continue", "regenerate"] as const)("restores title, provider and draft after native %s settlement", async (operation) => {
  vi.setSystemTime(1_000);
  let disk: TaoThread[] = [];
  vi.mocked(nativeThreadStorage.load).mockImplementation(async () => structuredClone(disk));
  vi.mocked(nativeThreadStorage.save).mockImplementation(async (thread) => {
    const stored = disk.find((item) => item.id === thread.id);
    if (!stored || thread.updatedAt >= stored.updatedAt) {
      disk = [...disk.filter((item) => item.id !== thread.id), structuredClone(thread)];
    }
  });
  let controller!: ReturnType<typeof createChatController>;
  const reply = async function* (threadId: string): AsyncGenerator<TaoEvent> {
    const stored = disk.find((thread) => thread.id === threadId);
    yield { type: "block_start", index: 0, block: { type: "text" } };
    yield { type: "block_delta", index: 0, delta: { text: "Document value is 73" } };
    yield { type: "message_stop" };
    // Native settlement writes its canonical transcript after sending the
    // last event. Its timestamp must not reject the final UI preferences.
    vi.setSystemTime(Date.now() + 10);
    disk = [{ ...structuredClone(controller.getState().threads[threadId]),
      title: stored?.title ?? "New Tao chat", preferences: stored?.preferences, updatedAt: Date.now() }];
    vi.setSystemTime(Date.now() + 10);
  };
  controller = createChatController({ backend: {
    send: async (request) => reply(request.threadId),
    continue: async (threadId) => reply(threadId),
    regenerate: async (threadId) => reply(threadId),
  } });
  const hook = renderHook(() => useThreadHistory(controller));
  await settle();
  act(() => {
    controller.setProvider("ordinary-documents", { model: "qa-chat" });
    controller.setComposerText("Original conversation before branch");
  });
  await act(async () => { await controller.send(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(180); });
  const draft = operation === "send" ? "" : `Draft before ${operation}`;
  if (operation !== "send") {
    act(() => controller.setComposerText(draft));
    await act(async () => { await controller[operation === "continue" ? "continueReply" : "regenerate"](); });
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
  }
  hook.unmount(); await settle();

  const restored = createChatController();
  renderHook(() => useThreadHistory(restored)); await settle();
  const state = restored.getState();
  expect(state.threads[state.activeThreadId!].title).toBe("Original conversation before branch");
  expect(state.composer.provider).toBe("ordinary-documents");
  expect(state.composer.model).toBe("qa-chat");
  expect(state.composer.text).toBe(draft);
  const messages = state.threads[state.activeThreadId!].messages;
  expect(messages).toHaveLength(2);
  expect(messages[0].text).toBe("Original conversation before branch");
  expect(messages[1].text).toContain("Document value is 73");
});
