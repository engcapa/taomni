import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiStore } from "../../../stores/aiStore";
import { DEFAULT_CONFIG, DEFAULT_GROK_ACP_PROFILE } from "../../../stores/ai/defaults";
import { useChatStore } from "../../../stores/chatStore";
import { setLocale } from "../../../lib/i18n";
import { createChatController } from "./controller";
import { HandoffControls } from "./HandoffControls";

const aiBefore = useAiStore.getState(), chatBefore = useChatStore.getState();
beforeEach(() => {
  setLocale("en");
  useAiStore.setState({ config: { ...DEFAULT_CONFIG, cc_bridge: { ...DEFAULT_CONFIG.cc_bridge, enabled: true }, codex_bridge: { ...DEFAULT_CONFIG.codex_bridge, enabled: true }, acp_bridge: { ...DEFAULT_CONFIG.acp_bridge, enabled: true, profiles: [{ ...DEFAULT_GROK_ACP_PROFILE, enabled: true }] } } });
});
afterEach(() => { cleanup(); useAiStore.setState(aiBefore, true); useChatStore.setState(chatBefore, true); vi.restoreAllMocks(); });

describe("coding task handoff UI", () => {
  it.each([["codex", "codex"], ["claude", "claude-code"], ["acp", "acp:grok"]])("reviews %s context, dispatches once and returns a result after remount", async (button, provider) => {
    const newThread = vi.fn(async () => ({ id: "target" } as Awaited<ReturnType<typeof chatBefore.newThread>>));
    const enqueue = vi.fn(async () => ({ status: "sent" as const }));
    const loadMessages = vi.fn(async () => {});
    useChatStore.setState({ newThread, enqueueMessage: enqueue, loadMessages, sendingByThreadId: {}, messages: { target: [{ id: "result", thread_id: "target", role: "assistant", content: "Implemented; tests failed, repair still needed.", created_at: 1, redacted: false }] } });
    const controller = createChatController();
    controller.hydrateThreads([{ id: "source", title: "Project", updatedAt: 1, messages: [{ id: "question", role: "user", text: "Build a project", createdAt: 1, blocks: [] }, { id: "answer", role: "assistant", text: "Plan", createdAt: 2, blocks: [] }] }]);
    const view = render(<HandoffControls controller={controller} messageId="answer" />);
    fireEvent.click(screen.getByTestId(`tao-home-message-${button}`));
    expect(screen.getByTestId("tao-home-handoff-preview")).toHaveTextContent("Build a project");
    expect(newThread).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("tao-home-handoff-confirm")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`tao-home-message-${button}`));
    fireEvent.click(screen.getByTestId("tao-home-handoff-confirm"));
    await waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(newThread).toHaveBeenCalledWith(provider, undefined);
    expect(enqueue.mock.calls[0]).toEqual(["target", expect.stringContaining("Build a project")]);
    view.unmount();
    const reopened = createChatController(); reopened.hydrateThreads(Object.values(controller.getState().threads));
    render(<HandoffControls controller={reopened} messageId="answer" />);
    await act(async () => { fireEvent.click(screen.getByTestId("tao-home-handoff-return")); });
    expect(loadMessages).toHaveBeenCalledWith("target");
    expect(reopened.getState().composer.chips).toEqual([expect.objectContaining({ preview: expect.stringContaining("tests failed"), reference: "target:result" })]);
    expect(reopened.getState().composer.text).toBeTruthy();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("disables all bridges when cloud AI is disabled", () => {
    useAiStore.setState({ config: { ...useAiStore.getState().config!, fully_disabled: true } });
    render(<HandoffControls controller={createChatController()} messageId="absent" />);
    for (const button of ["codex", "claude", "acp"]) expect(screen.getByTestId(`tao-home-message-${button}`)).toBeDisabled();
  });
});
