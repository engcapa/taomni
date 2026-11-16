import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChatController, type TaoThread } from "../ai-chat";
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
