import { vi } from "vitest";
import type { ChatAttachment } from "../../../lib/chat/attachments";
import { DEFAULT_CLAUDE_CODE_MODEL, DEFAULT_CODEX_MODEL, DEFAULT_GROK_ACP_PROFILE, type AiConfig } from "../../aiStore";
import { type ChatThread } from "../../chatStore";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

export function makeConfig(overrides: Partial<AiConfig> = {}): AiConfig {
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
    acp_bridge: {
      enabled: false,
      active_profile_id: "grok",
      proxy_mode: "direct",
      request_timeout_seconds: 120,
      profiles: [{ ...DEFAULT_GROK_ACP_PROFILE, args: [...DEFAULT_GROK_ACP_PROFILE.args] }],
    },
    full_local_mode: false,
    fully_disabled: false,
    chat_output_format: "md",
    chat_send_shortcut: "ctrl_enter",
    ...overrides,
  };
}

export function makeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "thread-1",
    title: "New chat",
    provider_id: "claude-code",
    created_at: 1,
    updated_at: 1,
    linked_session_id: null,
    source: "drawer",
    mode: "chat",
    output_format: null,
    cc_model: null,
    ...overrides,
  };
}

export function attachment(path: string): ChatAttachment {
  const name = path.split(/[\\/]/).pop() ?? path;
  return { id: `att-${name}`, kind: "file", name, path, size: 1024, mime: "text/plain" };
}

export { invokeMock };
