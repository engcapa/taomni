import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore, type ChatThread } from "./chatStore";
import { DEFAULT_CLAUDE_CODE_MODEL, DEFAULT_CODEX_MODEL, useAiStore, type AiConfig } from "./aiStore";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

function makeConfig(overrides: Partial<AiConfig> = {}): AiConfig {
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
        deepseek: {
          base_url: "https://api.deepseek.com/v1",
          api_key: "",
          model: "deepseek-chat",
          runtime: "openai-compat",
        },
        local: {
          base_url: "http://127.0.0.1:8080/v1",
          api_key: "local",
          model: "qwen3",
          runtime: "llama-server",
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
    ...overrides,
  };
}

function makeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "thread-1",
    title: "New chat",
    provider_id: "claude-code",
    created_at: 1,
    updated_at: 1,
    linked_session_id: null,
    source: "drawer",
    output_format: null,
    cc_model: null,
    ...overrides,
  };
}

describe("chatStore new thread provider selection", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useAiStore.setState({
      config: makeConfig(),
      loading: false,
      saving: false,
      testResults: {},
      voiceShellEnabled: false,
    });
    useChatStore.setState({
      threads: [],
      threadsLoaded: true,
      activeThreadId: null,
      messages: {},
      streamingId: {},
      ccToolCards: {},
      ccUsage: {},
      sendingByThreadId: {},
      sending: false,
      drawerOpen: false,
      drawerScope: null,
      drawerTabId: null,
      tabDrawerOpenByTabId: {},
      drawerWidth: 380,
      pendingComposerText: "",
    });
    invokeMock.mockImplementation((command: string, args: { providerId?: string | null; linkedSessionId?: string | null }) => {
      if (command !== "chat_new_thread") throw new Error(`unexpected command: ${command}`);
      const thread = makeThread({
        provider_id: args.providerId ?? "deepseek",
        linked_session_id: args.linkedSessionId ?? null,
      });
      return Promise.resolve(thread);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses Claude Code as the default provider when it is enabled", async () => {
    await useChatStore.getState().newThread(undefined, "term-1");

    expect(invokeMock).toHaveBeenCalledWith("chat_new_thread", {
      providerId: "claude-code",
      linkedSessionId: "term-1",
    });
  });

  it("keeps an explicitly selected provider even when Claude Code is enabled", async () => {
    await useChatStore.getState().newThread("local", undefined);

    expect(invokeMock).toHaveBeenCalledWith("chat_new_thread", {
      providerId: "local",
      linkedSessionId: null,
    });
  });

  it("opens a Claude Code thread instead of reusing another provider as the default", async () => {
    useChatStore.setState({
      threads: [makeThread({ id: "old-thread", title: "Old chat", provider_id: "deepseek" })],
    });

    await useChatStore.getState().openGlobalChat();

    expect(invokeMock).toHaveBeenCalledWith("chat_new_thread", {
      providerId: "claude-code",
      linkedSessionId: null,
    });
    expect(useChatStore.getState().activeThreadId).toBe("thread-1");
  });
});

describe("chatStore drawer lifecycle", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    useAiStore.setState({
      config: makeConfig(),
      loading: false,
      saving: false,
      testResults: {},
      voiceShellEnabled: false,
    });
    useChatStore.setState({
      threads: [
        makeThread({ id: "thread-a", linked_session_id: "term-a" }),
        makeThread({ id: "thread-b", linked_session_id: "term-b" }),
        makeThread({ id: "global-thread", linked_session_id: null }),
      ],
      threadsLoaded: true,
      activeThreadId: "thread-a",
      messages: {},
      streamingId: {},
      ccToolCards: {},
      ccUsage: {},
      sendingByThreadId: { "thread-a": true },
      sending: true,
      drawerOpen: true,
      drawerScope: "tab",
      drawerTabId: "term-a",
      tabDrawerOpenByTabId: { "term-a": true },
      drawerWidth: 380,
      pendingComposerText: "",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("hides a tab-bound drawer on active-tab sync without stopping the running thread", async () => {
    await useChatStore.getState().syncTabChatWithActiveTab("term-b");

    expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      drawerScope: "tab",
      drawerTabId: "term-b",
      sending: true,
      sendingByThreadId: { "thread-a": true },
      tabDrawerOpenByTabId: { "term-a": true },
    });
  });

  it("hides a tab-bound drawer when switching to a non-chat tab without stopping", async () => {
    await useChatStore.getState().syncTabChatWithActiveTab(null);

    expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      drawerTabId: null,
      sending: true,
      sendingByThreadId: { "thread-a": true },
      tabDrawerOpenByTabId: { "term-a": true },
    });
  });

  it("lets automatic visibility changes hide the drawer without stopping", () => {
    useChatStore.getState().setDrawerOpen(false);

    expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      sending: true,
      sendingByThreadId: { "thread-a": true },
    });
  });

  it("stops the active thread when the user explicitly closes a tab drawer", async () => {
    await useChatStore.getState().toggleTabChat("term-a");

    expect(invokeMock).toHaveBeenCalledWith("chat_stop_stream", { threadId: "thread-a" });
    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      sending: false,
      sendingByThreadId: {},
      tabDrawerOpenByTabId: { "term-a": false },
    });
  });

  it("stops the active thread when the user explicitly closes a global drawer", async () => {
    useChatStore.setState({
      activeThreadId: "global-thread",
      drawerOpen: true,
      drawerScope: "global",
      drawerTabId: null,
      sendingByThreadId: { "global-thread": true },
      sending: true,
    });

    await useChatStore.getState().toggleGlobalChat();

    expect(invokeMock).toHaveBeenCalledWith("chat_stop_stream", { threadId: "global-thread" });
    expect(useChatStore.getState()).toMatchObject({
      drawerOpen: false,
      sending: false,
      sendingByThreadId: {},
    });
  });
});
