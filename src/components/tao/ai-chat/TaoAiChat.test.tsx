import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatController } from "./controller";
import { TaoAiChat } from "./TaoAiChat";
import type { ChatBackend, ChatProfile } from "./ports";

const profile: ChatProfile = {
  modes: [
    { id: "ask", label: "问" },
    { id: "do", label: "做" },
    { id: "research", label: "深研" },
  ],
  sidePanels: ["来源", "文件"],
  defaultModel: "deepseek-flash",
  defaultThinking: false,
  defaultWeb: false,
};

describe("TaoAiChat", () => {
  afterEach(() => cleanup());
  it("renders the host shell, sends with Ctrl+Enter, and exposes search shortcut", async () => {
    const backend: ChatBackend = {
      send: vi.fn<ChatBackend["send"]>(async () => [
        { type: "message_start" },
        { type: "block_start", index: 0, block: { type: "text" } },
        { type: "block_delta", index: 0, delta: { text: "回答" } },
        { type: "message_stop" },
      ]),
    };
    const controller = createChatController({ backend, profile });
    render(<TaoAiChat controller={controller} profile={profile} slots={{ belowComposer: <div data-testid="host-slot">快捷行</div> }} />);
    expect(screen.getByTestId("tao-home-mode-ask")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("host-slot")).toBeInTheDocument();

    const input = screen.getByTestId("tao-home-composer-input");
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.getByText("回答")).toBeInTheDocument());
    expect(backend.send).toHaveBeenCalledWith(expect.objectContaining({ content: "你好", mode: "ask" }), expect.any(AbortSignal));

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(controller.getState().ui.searchOpen).toBe(true);
  });

  it("keeps the composer disabled when the host has no provider key", () => {
    const controller = createChatController({ profile });
    render(<TaoAiChat controller={controller} profile={profile} disabled slots={{ emptyState: <p>连接 DeepSeek</p> }} />);
    expect(screen.getByTestId("tao-home-composer").querySelector("textarea")).toBeDisabled();
    expect(screen.getByText("连接 DeepSeek")).toBeInTheDocument();
  });

  it("shows a stopped response card and previews redacted context chips", async () => {
    let release!: () => void;
    const backend: ChatBackend = {
      send: vi.fn<ChatBackend["send"]>(() => new Promise<Iterable<never>>((resolve) => { release = () => resolve([]); })),
      continue: vi.fn<NonNullable<ChatBackend["continue"]>>(async () => []),
    };
    const controller = createChatController({ backend, profile });
    controller.setChips([{ id: "local-1", kind: "local", label: "构建日志", preview: "token=[REDACTED]", removable: true }]);
    render(<TaoAiChat controller={controller} profile={profile} />);
    fireEvent.change(screen.getByTestId("tao-home-composer-input"), { target: { value: "继续" } });
    const pending = controller.send();
    await waitFor(() => expect(controller.getState().runtime[controller.getState().activeThreadId!].phase).toBe("sending"));
    await controller.stop();
    expect(screen.getByTestId("tao-home-stopped-state")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "预览 构建日志" }));
    expect(screen.getByRole("dialog", { name: "构建日志 的脱敏预览" })).toHaveTextContent("[REDACTED]");
    // Let the aborted transport settle before requesting continuation. The
    // controller keeps one transport owner per thread until its finally block.
    release();
    await pending;
    fireEvent.click(screen.getByRole("button", { name: "继续生成" }));
    await waitFor(() => expect(backend.continue).toHaveBeenCalled());
  });
});
