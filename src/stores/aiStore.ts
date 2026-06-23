import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  vaultStatus,
  VAULT_LOCKED_EVENT,
  VAULT_LOCKED_ERROR,
} from "../lib/ipc";

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
  web_search: WebSearchConfig;
  cc_bridge: CcBridgeConfig;
  full_local_mode?: boolean;
  fully_disabled?: boolean;
  /** Default output format for chat replies: "md" | "html" | "plain". */
  chat_output_format?: string;
}

export interface CcCustomSettingsProfile {
  id: string;
  name: string;
  enabled: boolean;
  vault_ref: string;
  created_at: number;
}

export interface CcBridgeConfig {
  enabled: boolean;
  binary: string;
  min_version: string;
  default_model: string;
  permission_mode: string;
  max_turns: number;
  /** When true, read-only Bash/run_in_terminal commands still need a confirmation (3.6). */
  confirm_readonly?: boolean;
  /** Mirror finished captured runs into the bound terminal as display-only traces. */
  terminal_echo_enabled?: boolean;
  custom_settings_profiles?: CcCustomSettingsProfile[];
  active_profile_id?: string;
}

export interface WebSearchConfig {
  client_provider: string;
  client_enabled: boolean;
  confirm_mode: string;
  byok_key: string;
  searxng_url?: string;
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
  voiceShellEnabled: boolean;

  loadConfig: () => Promise<void>;
  saveConfig: (config: AiConfig) => Promise<void>;
  updateLlmProvider: (id: string, provider: LlmProviderConfig) => void;
  setActiveLlmProvider: (id: string) => void;
  testConnection: (providerId: string, provider: LlmProviderConfig) => Promise<void>;
  toggleVoiceShell: () => void;
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
  web_search: {
    client_provider: "searxng",
    client_enabled: false,
    confirm_mode: "per_call",
    byok_key: "",
    searxng_url: undefined,
  },
  cc_bridge: {
    enabled: false,
    binary: "auto",
    min_version: "1.0.0",
    default_model: "sonnet",
    permission_mode: "default",
    max_turns: 20,
    confirm_readonly: false,
    terminal_echo_enabled: true,
  },
  full_local_mode: false,
  fully_disabled: false,
  chat_output_format: "md",
};

export const useAiStore = create<AiStore>((set, get) => ({
  config: null,
  loading: false,
  saving: false,
  testResults: {},
  voiceShellEnabled: false,

  toggleVoiceShell: () => set((s) => ({ voiceShellEnabled: !s.voiceShellEnabled })),

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
      // Identify providers carrying a fresh plaintext API key — those are the
      // ones we want to push into the vault. (Providers with an existing
      // `vault:<id>` ref or the local sidecar's literal "local" are skipped.)
      const providersNeedingVault = Object.entries(config.llm.providers).filter(
        ([, p]) =>
          p.api_key &&
          p.api_key.length > 0 &&
          !p.api_key.startsWith("vault:") &&
          p.runtime !== "llama-server" &&
          p.api_key !== "local",
      );

      // If we have plaintext keys to encrypt but the vault is locked or
      // uninitialized, we MUST NOT fall back to writing plaintext to ai.json
      // — the user thought they were saving into the encrypted vault, and a
      // future restart would silently use a plaintext key. Instead, surface
      // the unlock dialog and abort the save so the user can retry.
      if (providersNeedingVault.length > 0) {
        const status = await vaultStatus().catch(() => null);
        if (status && status.state !== "unlocked") {
          set({ saving: false });
          window.dispatchEvent(
            new CustomEvent(VAULT_LOCKED_EVENT, {
              detail: {
                reason:
                  "Unlock the credential vault so the AI provider's API key can be encrypted before saving.",
              },
            }),
          );
          throw new Error(
            `${VAULT_LOCKED_ERROR}: unlock the credential vault before saving the AI provider's API key.`,
          );
        }
      }

      // For each provider whose api_key is plaintext (not already a vault: ref),
      // store it in the vault and replace the field with the returned `vault:<id>`
      // reference.
      const providers: Record<string, LlmProviderConfig> = {};
      for (const [id, p] of Object.entries(config.llm.providers)) {
        if (
          p.api_key &&
          p.api_key.length > 0 &&
          !p.api_key.startsWith("vault:") &&
          p.runtime !== "llama-server" &&
          p.api_key !== "local"
        ) {
          try {
            const ref = await invoke<string>("save_ai_api_key", {
              kind: `ai_api_key:${id}`,
              label: `LLM Provider: ${id}`,
              plaintext: p.api_key,
            });
            providers[id] = { ...p, api_key: ref };
          } catch (err) {
            // Should be unreachable — we guarded above. But if the vault
            // got re-locked between the check and the put, surface it.
            const msg = String(err);
            if (msg.includes(VAULT_LOCKED_ERROR)) {
              set({ saving: false });
              window.dispatchEvent(
                new CustomEvent(VAULT_LOCKED_EVENT, {
                  detail: {
                    reason:
                      "Unlock the credential vault so the AI provider's API key can be encrypted before saving.",
                  },
                }),
              );
              throw err;
            }
            providers[id] = p;
          }
        } else {
          providers[id] = p;
        }
      }

      const safeConfig: AiConfig = {
        ...config,
        llm: { ...config.llm, providers },
      };

      await invoke("save_ai_config", { config: safeConfig });
      set({ config: safeConfig, saving: false });
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
