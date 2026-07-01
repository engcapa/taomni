import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatDrawer, ChatDrawerRibbon } from "./ChatDrawer";
import { useAppStore } from "../../stores/appStore";
import { useChatStore, type ChatThread } from "../../stores/chatStore";
import { useTaoHubStore } from "../../stores/taoHubStore";
import { useNotesStore } from "../../stores/notesStore";
import { useTaoAlertStore } from "../../stores/taoAlertStore";
import { DEFAULT_CLAUDE_CODE_MODEL, DEFAULT_CODEX_MODEL, useAiStore, type AiConfig } from "../../stores/aiStore";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
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
      provider_groups: {},
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
      if (command === "notes_list") return Promise.resolve([]);
      if (command === "notes_get_prefs") return Promise.resolve({});
      if (command === "notes_list_alerts") return Promise.resolve([]);
      if (command === "notes_list_tags") return Promise.resolve([]);
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

  it("includes provider groups in the manual provider picker", () => {
    const config = makeConfig();
    config.llm.provider_groups = {
      balanced: {
        label: "Balanced",
        provider_ids: ["deepseek", "local"],
        enabled: true,
      },
    };
    useAiStore.setState({ config });

    render(<ChatDrawer />);

    const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.value)).toEqual([
      "claude-code",
      "group:balanced",
      "deepseek",
      "local",
    ]);
    expect(Array.from(provider.options).map((option) => option.textContent)).toContain("Group: Balanced");
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
    useChatStore.setState({ drawerPosition: "top", drawerPinned: false });
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

  it("pins the drawer to the top edge as a full-width inline band", () => {
    useChatStore.setState({ drawerPosition: "top", drawerPinned: true });
    render(<ChatDrawer />);
    const drawer = screen.getByTestId("ai-chat-drawer");
    expect(drawer).toHaveAttribute("data-position", "top");
    expect(drawer).toHaveAttribute("data-pinned", "true");
    expect(drawer.className).toContain("w-full");
    const pin = screen.getByTestId("ai-chat-drawer-pin");
    expect(pin).toHaveAttribute("aria-pressed", "true");
    expect(pin).not.toBeDisabled();
  });

  it("does not dismiss a pinned top drawer on outside pointer down", () => {
    useChatStore.setState({ drawerPosition: "top", drawerPinned: true });
    render(<ChatDrawer />);
    fireEvent.pointerDown(document.body);
    expect(useChatStore.getState().drawerOpen).toBe(true);
  });

  it("keeps left/right pin as a side column (no regression)", () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    useChatStore.setState({ drawerPosition: "right", drawerPinned: true });
    render(<ChatDrawer />);
    const drawer = screen.getByTestId("ai-chat-drawer");
    expect(drawer.className).toContain("relative");
    expect(drawer.className).not.toContain("w-full");
    expect(screen.getByTestId("ai-chat-drawer-pin")).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the Tao Hub tab strip with Chat and Notes tabs", () => {
    useTaoHubStore.setState({ hubTab: "chat" });
    render(<ChatDrawer />);
    expect(screen.getByTestId("tao-hub-tab-chat")).toBeInTheDocument();
    expect(screen.getByTestId("tao-hub-tab-notes")).toBeInTheDocument();
    // Chat tab active by default → composer present, notes panel absent.
    expect(screen.queryByTestId("notes-panel")).not.toBeInTheDocument();
  });

  it("switches to the Notes tab and back without losing the chat view", () => {
    useTaoHubStore.setState({ hubTab: "chat" });
    render(<ChatDrawer />);

    fireEvent.click(screen.getByTestId("tao-hub-tab-notes"));
    expect(useTaoHubStore.getState().hubTab).toBe("notes");
    expect(screen.getByTestId("notes-panel")).toBeInTheDocument();
    expect(screen.getByTestId("notes-new")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tao-hub-tab-chat"));
    expect(useTaoHubStore.getState().hubTab).toBe("chat");
    expect(screen.queryByTestId("notes-panel")).not.toBeInTheDocument();
  });
});

describe("ChatDrawerRibbon", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useNotesStore.setState({ alerts: [] });
    useTaoAlertStore.setState({ aiDone: [] });
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

  it("badges pending alerts and jumps to the overdue note on click", () => {
    const openTabChat = vi.fn().mockResolvedValue(undefined);
    const setActiveNote = vi.fn();
    const ackAlert = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      tabs: [{ id: "term-1", chatTabId: "stable-chat", type: "terminal", title: "T", closable: true }],
      activeTabId: "term-1",
    });
    useChatStore.setState({ drawerOpen: false, drawerPosition: "left", drawerPinned: true, openTabChat });
    useTaoHubStore.setState({ hubTab: "chat" });
    useNotesStore.setState({
      alerts: [
        {
          id: "evt-1",
          note_id: "note-7",
          kind: "overdue",
          state: "pending",
          fire_at: 1,
          acknowledged_at: null,
          note_title: "Pay invoice",
          due_at: 1,
          reminder_at: null,
        },
      ],
      setActiveNote,
      ackAlert,
    });
    useTaoAlertStore.setState({ aiDone: [] });

    render(
      <div className="relative h-32 w-32">
        <ChatDrawerRibbon />
      </div>,
    );

    expect(screen.getByTestId("tao-ribbon-badge")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("ai-chat-drawer-ribbon"));
    expect(openTabChat).toHaveBeenCalledWith("stable-chat");
    expect(setActiveNote).toHaveBeenCalledWith("note-7");
    expect(ackAlert).toHaveBeenCalledWith("evt-1");
    expect(useTaoHubStore.getState().hubTab).toBe("notes");
  });

  it("opens the alert inbox when multiple alerts are pending", () => {
    useAppStore.setState({
      tabs: [{ id: "term-1", chatTabId: "stable-chat", type: "terminal", title: "T", closable: true }],
      activeTabId: "term-1",
    });
    useChatStore.setState({ drawerOpen: false, drawerPosition: "left", drawerPinned: true });
    useNotesStore.setState({
      alerts: [
        { id: "a", note_id: "n1", kind: "overdue", state: "pending", fire_at: 1, acknowledged_at: null, note_title: "A", due_at: 1, reminder_at: null },
        { id: "b", note_id: "n2", kind: "due_soon", state: "pending", fire_at: 2, acknowledged_at: null, note_title: "B", due_at: 2, reminder_at: null },
      ],
    });
    render(
      <div className="relative h-32 w-32">
        <ChatDrawerRibbon />
      </div>,
    );
    expect(screen.getByTestId("tao-ribbon-badge")).toHaveTextContent("2");
    fireEvent.click(screen.getByTestId("ai-chat-drawer-ribbon"));
    expect(screen.getByTestId("tao-alert-inbox")).toBeInTheDocument();
    expect(screen.getAllByTestId("tao-alert-inbox-item")).toHaveLength(2);
  });
});
