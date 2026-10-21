import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { VAULT_LOCKED_ERROR, VAULT_LOCKED_EVENT, vaultStatus } from "../lib/ipc";
import { DEFAULT_CONFIG } from "./ai/defaults";
import { type AiConfig, type AiStore, type AsrProviderConfig, type LlmProviderConfig, type LlmProviderGroupConfig, type TestConnectionResult } from "./ai/model";
import { configuredProviderApiKeys, isPlaintextAsrKey, isPlaintextVaultableKey, normalizeAiConfig, normalizeProviderGroup } from "./ai/normalization";

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
      set({ config: normalizeAiConfig(config), loading: false });
    } catch {
      set({ config: DEFAULT_CONFIG, loading: false });
    }
  },

  saveConfig: async (config: AiConfig) => {
    config = normalizeAiConfig(config);
    set({ saving: true });
    try {
      // Identify providers carrying fresh plaintext API keys — those are the
      // ones we want to push into the vault. (Providers with existing
      // `vault:<id>` refs or the local sidecar's literal "local" are skipped.)
      const providersNeedingVault = Object.entries(config.llm.providers).filter(
        ([, p]) => configuredProviderApiKeys(p).some((key) => isPlaintextVaultableKey(p, key)),
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

      // For each provider key whose value is plaintext (not already a vault: ref),
      // store it in the vault and replace it with the returned `vault:<id>` reference.
      const providers: Record<string, LlmProviderConfig> = {};
      for (const [id, p] of Object.entries(config.llm.providers)) {
        const apiKeys = configuredProviderApiKeys(p);
        const storedKeys: string[] = [];
        for (let index = 0; index < apiKeys.length; index += 1) {
          const key = apiKeys[index];
          if (!isPlaintextVaultableKey(p, key)) {
            storedKeys.push(key);
            continue;
          }
          try {
            const ref = await invoke<string>("save_ai_api_key", {
              kind: index === 0 ? `ai_api_key:${id}` : `ai_api_key:${id}:${index + 1}`,
              label: index === 0 ? `LLM Provider: ${id}` : `LLM Provider: ${id} #${index + 1}`,
              plaintext: key,
            });
            storedKeys.push(ref);
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
            storedKeys.push(key);
          }
        }
        providers[id] = {
          ...p,
          api_key: storedKeys[0] ?? "",
          api_keys: storedKeys,
        };
      }

      const safeConfig: AiConfig = {
        ...config,
        llm: { ...config.llm, providers },
      };

      const asrProviders: Record<string, AsrProviderConfig> = {};
      for (const [id, provider] of Object.entries(config.asr.providers ?? {})) {
        const key = provider.api_key ?? "";
        if (!isPlaintextAsrKey(key)) {
          asrProviders[id] = provider;
          continue;
        }
        const ref = await invoke<string>("save_ai_api_key", {
          kind: `asr_api_key:${id}`,
          label: `ASR Provider: ${id}`,
          plaintext: key,
        });
        asrProviders[id] = { ...provider, api_key: ref };
      }
      safeConfig.asr = { ...config.asr, providers: asrProviders };

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

  updateLlmProviderGroup: (id: string, group: LlmProviderGroupConfig) => {
    const config = get().config;
    if (!config) return;
    set({
      config: {
        ...config,
        llm: {
          ...config.llm,
          provider_groups: {
            ...config.llm.provider_groups,
            [id]: normalizeProviderGroup(id, group),
          },
        },
      },
    });
  },

  removeLlmProviderGroup: (id: string) => {
    const config = get().config;
    if (!config) return;
    const providerGroups = { ...config.llm.provider_groups };
    delete providerGroups[id];
    set({
      config: {
        ...config,
        llm: {
          ...config.llm,
          provider_groups: providerGroups,
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
      const firstKey = configuredProviderApiKeys(provider)[0] ?? "";
      const result = await invoke<TestConnectionResult>("test_llm_connection", {
        provider: {
          ...provider,
          api_key: firstKey,
          api_keys: [firstKey],
        },
      });
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

export {
  type AcpBridgeConfig,
  type AcpProfileCapabilities,
  type AcpProfileConfig,
  type AiConfig,
  type AsrConfig,
  type AsrProviderConfig,
  type CcBridgeConfig,
  type CcCustomSettingsProfile,
  type CodexBridgeConfig,
  type CodexCustomConfigProfile,
  type FallbackConfig,
  type LlmConfig,
  type LlmProviderCapabilities,
  type LlmProviderCapability,
  type LlmProviderConfig,
  type LlmProviderGroupConfig,
  type TestConnectionResult,
  type WebSearchConfig,
} from "./ai/model";

export { ACP_PROVIDER_PREFIX, DEFAULT_CLAUDE_CODE_MODEL, DEFAULT_CODEX_MODEL, DEFAULT_GROK_ACP_PROFILE } from "./ai/defaults";

export {
  acpProfileIdFromProvider,
  acpProviderId,
  chatDrawerProviderIds,
  defaultChatProviderId,
  isAcpAvailableForChat,
  isClaudeCodeAvailableForChat,
  isCodexAvailableForChat,
  llmProviderSupports,
  PROVIDER_GROUP_PREFIX,
  providerGroupIdFromRoute,
  providerGroupRouteId,
} from "./ai/providers";

export { readChatDrawerProviderPreference, rememberChatDrawerProviderPreference } from "./ai/preference";
