import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatDrawer } from "./ChatDrawer";
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
});
