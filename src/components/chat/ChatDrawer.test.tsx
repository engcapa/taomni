import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatDrawer, ChatDrawerRibbon } from "./ChatDrawer";
import { useAppStore } from "../../stores/appStore";
import { useChatStore, type ChatThread } from "../../stores/chatStore";
import { DEFAULT_CLAUDE_CODE_MODEL, DEFAULT_CODEX_MODEL, useAiStore, type AiConfig } from "../../stores/aiStore";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

function makeConfig(): AiConfig {
  return {
    asr: {
      active: "sherpa-zipformer-zh-en",
      providers: {
        "sherpa-zipformer-zh-en": {
          engine: "sherpa-onnx",
          model: "streaming-zipformer-bilingual-zh-en-small",
        },
      },
      warm_on_startup: true,
      vad: "silero",
    },
    llm: {
      active: "deepseek",
      providers: {
        local: {
          base_url: "http://127.0.0.1:8080/v1",
          api_key: "local",
          model: "qwen3",
          runtime: "llama-server",
        },
        deepseek: {
          base_url: "https://api.deepseek.com/v1",
          api_key: "",
          model: "deepseek-chat",
          runtime: "openai-compat",
        },
      },
      fallback: { enabled: true, primary: "deepseek", secondary: "local", timeout_ms: 8000 },
      task_routing: { chat_drawer: "deepseek" },
    },
    web_search: {
      client_provider: "searxng",
      client_enabled: false,
      confirm_mode: "per_call",
      byok_key: "",
    },
    cc_bridge: {
      enabled: true,
      binary: "auto",
      min_version: "1.0.0",
      default_model: DEFAULT_CLAUDE_CODE_MODEL,
      permission_mode: "default",
      max_turns: 20,
      confirm_readonly: false,
      terminal_echo_enabled: true,
    },
    codex_bridge: {
      enabled: false,
      binary: "auto",
      min_version: "0.100.0",
      default_model: DEFAULT_CODEX_MODEL,
      sandbox: "read-only",
      approval_policy: "never",
      network_access: false,
      proxy_url: undefined,
      confirm_readonly: false,
      terminal_echo_enabled: true,
    },
    full_local_mode: false,
    fully_disabled: false,
    chat_output_format: "md",
  };
}

describe("ChatDrawer provider and echo controls", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "chat_list_threads") return Promise.resolve([]);
      if (command === "chat_purge_old") return Promise.resolve(0);
      if (command === "get_ai_config") return Promise.resolve(makeConfig());
      if (command === "save_ai_config") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    const thread: ChatThread = {
      id: "thread-1",
      title: "New chat",
      provider_id: "claude-code",
      created_at: 1,
      updated_at: 1,
      linked_session_id: "term-1",
      source: "drawer",
      mode: "chat",
      output_format: null,
      cc_model: null,
    };
    useAiStore.setState({
      config: makeConfig(),
      loading: false,
      saving: false,
      testResults: {},
      voiceShellEnabled: false,
    });
    useAppStore.setState({
      tabs: [{ id: "term-1", type: "terminal", title: "Terminal 1", closable: true }],
      activeTabId: "term-1",
      sqlEcho: false,
    });
    useChatStore.setState({
      threads: [thread],
      threadsLoaded: true,
      activeThreadId: thread.id,
      messages: { [thread.id]: [] },
      streamingId: {},
      ccToolCards: {},
      ccUsage: {},
      sendingByThreadId: {},
      sending: false,
      drawerOpen: true,
      drawerScope: "tab",
      drawerTabId: "term-1",
      tabDrawerOpenByTabId: { "term-1": true },
      drawerWidth: 380,
      drawerHeight: 420,
      drawerPosition: "right",
      drawerPinned: true,
      pendingComposerText: "",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("puts Claude Code before the active LLM provider", () => {
    render(<ChatDrawer />);

    const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.value)).toEqual([
      "claude-code",
      "deepseek",
      "local",
    ]);
  });

  it("renders terminal echo as the same compact button style as echo toggles", () => {
    render(<ChatDrawer />);

    const echo = screen.getByTestId("chat-cc-terminal-echo-toggle");
    expect(echo).toHaveClass("taomni-btn");
    expect(echo).toHaveAttribute("aria-pressed", "true");
    expect(echo).toHaveTextContent("Terminal echo: on");
  });

  it("filters provider options by the active media mode capability", () => {
    const config = makeConfig();
    config.llm.providers.agnes = {
      base_url: "https://apihub.agnes-ai.com/v1",
      api_key: "",
      model: "agnes-2.0-flash",
      runtime: "openai-compat",
      capabilities: { chat: true, image_generation: true, video_generation: true },
      image_model: "agnes-image-2.1-flash",
      video_model: "agnes-video-v2.0",
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "chat_list_threads") return Promise.resolve([]);
      if (command === "chat_purge_old") return Promise.resolve(0);
      if (command === "get_ai_config") return Promise.resolve(config);
      if (command === "save_ai_config") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    const imageThread: ChatThread = {
      ...useChatStore.getState().threads[0],
      provider_id: "agnes",
      mode: "image",
    };
    useAiStore.setState({ config });
    useChatStore.setState({
      threads: [imageThread],
      activeThreadId: imageThread.id,
      messages: { [imageThread.id]: [] },
    });

    render(<ChatDrawer />);

    const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.value)).toEqual(["agnes"]);
    expect(screen.getByTestId("chat-mode-image")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ChatDrawer layout resizing", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "chat_list_threads") return Promise.resolve([]);
      if (command === "chat_purge_old") return Promise.resolve(0);
      if (command === "get_ai_config") return Promise.resolve(makeConfig());
      return Promise.resolve(null);
    });

    const thread: ChatThread = {
      id: "thread-1",
      title: "New chat",
      provider_id: "claude-code",
      created_at: 1,
      updated_at: 1,
      linked_session_id: "term-1",
      source: "drawer",
      mode: "chat",
      output_format: null,
      cc_model: null,
    };
    useAiStore.setState({
      config: makeConfig(),
      loading: false,
      saving: false,
      testResults: {},
      voiceShellEnabled: false,
    });
    useAppStore.setState({
      tabs: [{ id: "term-1", type: "terminal", title: "Terminal 1", closable: true }],
      activeTabId: "term-1",
      sqlEcho: false,
    });
    useChatStore.setState({
      threads: [thread],
      threadsLoaded: true,
      activeThreadId: thread.id,
      messages: { [thread.id]: [] },
      streamingId: {},
      ccToolCards: {},
      ccUsage: {},
      sendingByThreadId: {},
      sending: false,
      drawerOpen: true,
      drawerScope: "tab",
      drawerTabId: "term-1",
      tabDrawerOpenByTabId: { "term-1": true },
      drawerWidth: 380,
      drawerHeight: 420,
      drawerPinned: false,
      pendingComposerText: "",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("dismisses a floating drawer on outside pointer down", () => {
    useChatStore.setState({ drawerPosition: "top" });
    render(<ChatDrawer />);

    fireEvent.pointerDown(document.body);

    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      tabDrawerOpenByTabId: { "term-1": false },
    });
  });

  it("resizes a top drawer by dragging its bottom edge", () => {
    useChatStore.setState({ drawerPosition: "top" });
    render(<ChatDrawer />);

    const handle = screen.getByTestId("ai-chat-drawer-height-resize");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 400, clientY: 420 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 520 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 520 });

    expect(useChatStore.getState().drawerHeight).toBe(520);
  });

  it("resizes a bottom drawer by dragging its top edge", () => {
    useChatStore.setState({ drawerPosition: "bottom" });
    render(<ChatDrawer />);

    const handle = screen.getByTestId("ai-chat-drawer-height-resize");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 400, clientY: 420 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 320 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 320 });

    expect(useChatStore.getState().drawerHeight).toBe(520);
  });
});

describe("ChatDrawerRibbon", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows only Tao and opens the stable chat tab id", () => {
    const openTabChat = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      tabs: [{
        id: "visual-tab",
        chatTabId: "stable-chat-tab",
        type: "terminal",
        title: "Terminal",
        closable: true,
      }],
      activeTabId: "visual-tab",
    });
    useChatStore.setState({
      drawerOpen: false,
      drawerPosition: "left",
      drawerPinned: true,
      openTabChat,
    });

    render(
      <div className="relative h-32 w-32">
        <ChatDrawerRibbon />
      </div>,
    );

    const ribbon = screen.getByTestId("ai-chat-drawer-ribbon");
    expect(ribbon).toHaveTextContent(/^Tao$/);
    expect(ribbon).toHaveClass("rounded-r-full");
    fireEvent.click(ribbon);
    expect(openTabChat).toHaveBeenCalledWith("stable-chat-tab");
  });

  it.each([
    ["left", 4, 300],
    ["right", 796, 300],
    ["top", 400, 4],
    ["bottom", 400, 596],
  ] as const)("docks the ribbon to the nearest %s edge when dragged", (expected, clientX, clientY) => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    useAppStore.setState({
      tabs: [{ id: "term-1", type: "terminal", title: "Terminal", closable: true }],
      activeTabId: "term-1",
    });
    useChatStore.setState({
      drawerOpen: false,
      drawerPosition: "left",
      drawerPinned: true,
    });

    render(
      <div className="relative h-32 w-32">
        <ChatDrawerRibbon />
      </div>,
    );

    const ribbon = screen.getByTestId("ai-chat-drawer-ribbon");
    fireEvent.pointerDown(ribbon, { button: 0, pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(ribbon, { pointerId: 1, clientX, clientY });
    fireEvent.pointerUp(ribbon, { pointerId: 1, clientX, clientY });

    expect(useChatStore.getState().drawerPosition).toBe(expected);
  });

  it("delays top and bottom hover-open long enough for drag to start", () => {
    vi.useFakeTimers();
    const openTabChat = vi.fn().mockResolvedValue(undefined);
    try {
      useAppStore.setState({
        tabs: [{ id: "term-1", type: "terminal", title: "Terminal", closable: true }],
        activeTabId: "term-1",
      });
      useChatStore.setState({
        drawerOpen: false,
        drawerPosition: "top",
        drawerPinned: false,
        openTabChat,
      });

      render(
        <div className="relative h-32 w-32">
          <ChatDrawerRibbon />
        </div>,
      );

      const ribbon = screen.getByTestId("ai-chat-drawer-ribbon");
      fireEvent.mouseEnter(ribbon);
      vi.advanceTimersByTime(300);
      expect(openTabChat).not.toHaveBeenCalled();

      fireEvent.pointerDown(ribbon, { button: 0, pointerId: 1, clientX: 400, clientY: 4 });
      vi.advanceTimersByTime(1000);
      expect(openTabChat).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
