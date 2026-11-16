import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatController } from "./controller";
import { TaoAiChat } from "./TaoAiChat";
import type { ChatBackend, ChatProfile } from "./ports";
import { setLocale } from "../../../lib/i18n";

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
  afterEach(() => { cleanup(); setLocale("en"); });
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
      regenerate: vi.fn<NonNullable<ChatBackend["regenerate"]>>(async () => []),
    };
    const controller = createChatController({ backend, profile });
    controller.setChips([{ id: "local-1", kind: "local", label: "构建日志", preview: "token=[REDACTED]", removable: true }]);
    render(<TaoAiChat controller={controller} profile={profile} />);
    fireEvent.change(screen.getByTestId("tao-home-composer-input"), { target: { value: "继续" } });
    const pending = controller.send();
    await waitFor(() => expect(controller.getState().runtime[controller.getState().activeThreadId!].phase).toBe("sending"));
    await controller.stop();
    expect(screen.getByTestId("tao-home-stopped-state")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Preview.*构建日志|预览.*构建日志/ }));
    expect(screen.getByRole("dialog", { name: /构建日志/ })).toHaveTextContent("[REDACTED]");
    // Let the aborted transport settle before requesting continuation. The
    // controller keeps one transport owner per thread until its finally block.
    release();
    await pending;
    expect(screen.getByTestId("tao-home-stopped-state")).toHaveTextContent("No reply was received");
    fireEvent.click(screen.getByTestId("tao-home-regenerate"));
    await waitFor(() => expect(backend.regenerate).toHaveBeenCalled());
  });

  it("switches Tao chrome language without recreating controller or losing draft", async () => {
    const controller = createChatController({ profile });
    controller.setComposerText("draft");
    render(<TaoAiChat controller={controller} profile={profile} />);
    const id = controller.getState().activeThreadId;
    expect(screen.getByTestId("tao-home-new-chat")).toHaveTextContent("New Tao chat");
    setLocale("zh-CN");
    await waitFor(() => expect(screen.getByTestId("tao-home-new-chat")).toHaveTextContent("新 Tao 对话"));
    expect(controller.getState().activeThreadId).toBe(id);
    expect(controller.getState().composer.text).toBe("draft");
  });

  it("toggles the sidebar from the header and restores its selected view, width and draft", async () => {
    const controller = createChatController({ profile });
    controller.setComposerText("keep this draft");
    render(<TaoAiChat controller={controller} profile={profile} />);
    fireEvent.click(screen.getByTestId("tao-home-side-toggle"));

    const panel = await screen.findByTestId("tao-home-side-panel");
    expect(screen.getByTestId("tao-home-side-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("tao-home-side-tab-sources")).toHaveAttribute("title", "Sources");
    expect(screen.getByTestId("tao-home-side-tab-sources").textContent).toBe("");
    expect(screen.getByTestId("tao-home-side-tab-sources").querySelector("svg")).toBeInTheDocument();
    expect(screen.getByTestId("tao-home-side-resize")).toHaveAttribute("aria-label", "Resize sidebar");
    expect(panel).toHaveStyle({ width: "340px" });

    fireEvent.mouseDown(screen.getByTestId("tao-home-side-resize"), { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 40 });
    fireEvent.mouseUp(window);
    expect(panel).toHaveStyle({ width: "400px" });
    fireEvent.mouseMove(window, { clientX: 20 });
    expect(panel).toHaveStyle({ width: "400px" });

    fireEvent.click(screen.getByTestId("tao-home-side-tab-files"));
    expect(screen.getByTestId("tao-home-files")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tao-home-side-toggle"));
    expect(screen.queryByTestId("tao-home-side-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tao-home-sources")).not.toBeInTheDocument();
    expect(screen.getByTestId("tao-home-side-toggle")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByTestId("tao-home-side-toggle"));
    expect(screen.getByTestId("tao-home-side-panel")).toHaveStyle({ width: "400px" });
    expect(screen.getByTestId("tao-home-side-tab-files")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("tao-home-files")).toBeInTheDocument();
    expect(screen.getByTestId("tao-home-composer-input")).toHaveValue("keep this draft");
    expect(screen.queryByTestId("tao-home-side-close")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tao-home-side-collapse")).not.toBeInTheDocument();
  });

  it("bounds keyboard resizing, resets the width and releases a cancelled drag", async () => {
    const controller = createChatController({ profile });
    render(<TaoAiChat controller={controller} profile={profile} />);
    fireEvent.click(screen.getByTestId("tao-home-side-toggle"));
    const handle = await screen.findByTestId("tao-home-side-resize");
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "560");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "260");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "280");
    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute("aria-valuenow", "340");
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.pointerCancel(window);
    fireEvent.mouseMove(window, { clientX: 40 });
    expect(handle).toHaveAttribute("aria-valuenow", "340");
    expect(screen.getByTestId("tao-home-side-panel")).toHaveAttribute("data-resizing", "false");
  });

  it("keeps memory and skills icons distinct and routes visible settings controls once", async () => {
    const controller = createChatController({ profile });
    const onOpenSettings = vi.fn();
    const onOpenAppearance = vi.fn();
    render(<TaoAiChat controller={controller} profile={{ ...profile, sidePanels: ["记忆", "技能"] }} onOpenSettings={onOpenSettings} onOpenAppearance={onOpenAppearance} />);
    fireEvent.click(screen.getByTestId("tao-home-side-toggle"));
    const memory = await screen.findByTestId("tao-home-side-tab-memory");
    const skills = screen.getByTestId("tao-home-side-tab-skills");
    expect(memory.querySelector("svg")?.innerHTML).not.toBe(skills.querySelector("svg")?.innerHTML);
    expect(skills).toHaveAttribute("title", "Skills");
    fireEvent.click(screen.getByTestId("tao-home-settings"));
    fireEvent.click(screen.getByTestId("tao-home-appearance"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenAppearance).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("tao-home-demo-toggle"));
    expect(controller.getState().ui.demoMode).toBe(true);
    fireEvent.click(screen.getByTestId("tao-home-demo-toggle"));
    expect(controller.getState().ui.demoMode).toBe(false);
  });
});
