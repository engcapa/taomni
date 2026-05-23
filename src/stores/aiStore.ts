import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface AsrProviderConfig {
  engine: string;
  model: string;
}

export interface AsrConfig {
  active: string;
  providers: Record<string, AsrProviderConfig>;
  warm_on_startup: boolean;
  vad: string;
}

export interface LlmProviderConfig {
  base_url: string;
  api_key: string;
  model: string;
  runtime: string;
}

export interface FallbackConfig {
  enabled: boolean;
  primary: string;
  secondary: string;
  timeout_ms: number;
}

export interface LlmConfig {
  active: string;
  providers: Record<string, LlmProviderConfig>;
  fallback: FallbackConfig;
  task_routing: Record<string, string>;
}

export interface AiConfig {
  asr: AsrConfig;
  llm: LlmConfig;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  latency_ms: number;
}

interface AiStore {
  config: AiConfig | null;
  loading: boolean;
  saving: boolean;
  testResults: Record<string, TestConnectionResult | null>;

  loadConfig: () => Promise<void>;
  saveConfig: (config: AiConfig) => Promise<void>;
  updateLlmProvider: (id: string, provider: LlmProviderConfig) => void;
  setActiveLlmProvider: (id: string) => void;
  testConnection: (providerId: string, provider: LlmProviderConfig) => Promise<void>;
}

const DEFAULT_CONFIG: AiConfig = {
  asr: {
    active: "sherpa-zipformer-zh-en",
    providers: {
      "sherpa-zipformer-zh-en": { engine: "sherpa-onnx", model: "streaming-zipformer-bilingual-zh-en-small" },
      "whisper-base": { engine: "whisper-rs", model: "ggml-base-q5_1" },
    },
    warm_on_startup: true,
    vad: "silero",
  },
  llm: {
    active: "deepseek",
    providers: {
      deepseek:    { base_url: "https://api.deepseek.com/v1",                    api_key: "", model: "deepseek-chat",                        runtime: "openai-compat" },
      glm:         { base_url: "https://open.bigmodel.cn/api/paas/v4",           api_key: "", model: "glm-4-flash",                          runtime: "openai-compat" },
      siliconflow: { base_url: "https://api.siliconflow.cn/v1",                  api_key: "", model: "Qwen/Qwen2.5-Coder-7B-Instruct",       runtime: "openai-compat" },
      groq:        { base_url: "https://api.groq.com/openai/v1",                 api_key: "", model: "llama-3.3-70b-versatile",              runtime: "openai-compat" },
      local:       { base_url: "http://127.0.0.1:8080/v1",                       api_key: "local", model: "qwen3-1.7b-q4_k_m",             runtime: "llama-server" },
    },
    fallback: { enabled: true, primary: "deepseek", secondary: "local", timeout_ms: 8000 },
    task_routing: {
      voice_intent: "deepseek",
      voice_to_shell: "deepseek",
      tab_completion: "local",
      command_rewrite: "deepseek",
      chat_drawer: "deepseek",
      inline_qq: "deepseek",
      agent_default: "deepseek",
    },
  },
};

export const useAiStore = create<AiStore>((set, get) => ({
  config: null,
  loading: false,
  saving: false,
  testResults: {},

  loadConfig: async () => {
    set({ loading: true });
    try {
      const config = await invoke<AiConfig>("get_ai_config");
      set({ config, loading: false });
    } catch {
      set({ config: DEFAULT_CONFIG, loading: false });
    }
  },

  saveConfig: async (config: AiConfig) => {
    set({ saving: true });
    try {
      await invoke("save_ai_config", { config });
      set({ config, saving: false });
    } catch (e) {
      set({ saving: false });
      throw e;
    }
  },

  updateLlmProvider: (id: string, provider: LlmProviderConfig) => {
    const config = get().config;
    if (!config) return;
    set({
      config: {
        ...config,
        llm: {
          ...config.llm,
          providers: { ...config.llm.providers, [id]: provider },
        },
      },
    });
  },

  setActiveLlmProvider: (id: string) => {
    const config = get().config;
    if (!config) return;
    set({ config: { ...config, llm: { ...config.llm, active: id } } });
  },

  testConnection: async (providerId: string, provider: LlmProviderConfig) => {
    set((s) => ({ testResults: { ...s.testResults, [providerId]: null } }));
    try {
      const result = await invoke<TestConnectionResult>("test_llm_connection", { provider });
      set((s) => ({ testResults: { ...s.testResults, [providerId]: result } }));
    } catch (e) {
      set((s) => ({
        testResults: {
          ...s.testResults,
          [providerId]: { ok: false, message: String(e), latency_ms: 0 },
        },
      }));
    }
  },
}));
