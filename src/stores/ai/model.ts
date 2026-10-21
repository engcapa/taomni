import { type AppProxyConfig } from "../../lib/ipc";

export interface AsrProviderConfig {
  engine: string;
  model: string;
  endpoint?: string;
  api_key?: string;
  proxy_mode?: "app" | "custom" | "none" | string;
  proxy_url?: string;
  custom_proxy?: AppProxyConfig;
  app_id?: string;
  resource_id?: string;
  vocabulary_endpoint?: string;
}

export interface AsrConfig {
  download_proxy?: { mode: "app" | "custom" | "none"; custom: AppProxyConfig; };
  language?: string;
  language_prior?: string;
  hotwords?: string[];
  experimental?: boolean;
  cleanup?: "off" | "light" | "full";
  mode?: "local" | "online" | string;
  active: string;
  providers: Record<string, AsrProviderConfig>;
  warm_on_startup: boolean;
  vad: string;
}

export interface LlmProviderConfig {
  protocol_overrides?: Record<string, string>;
  base_url: string;
  api_key: string;
  api_keys?: string[];
  model: string;
  runtime: string;
  capabilities?: LlmProviderCapabilities;
  image_model?: string | null;
  video_model?: string | null;
  proxy_mode?: "app" | "custom" | "none" | "session" | "manual" | string;
  custom_proxy?: AppProxyConfig;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
}

export interface LlmProviderCapabilities {
  chat?: boolean;
  image_generation?: boolean;
  video_generation?: boolean;
}

export interface FallbackConfig {
  enabled: boolean;
  primary: string;
  secondary: string;
  timeout_ms: number;
}

export interface LlmProviderGroupConfig {
  label: string;
  provider_ids: string[];
  enabled?: boolean;
}

export interface LlmConfig {
  active: string;
  providers: Record<string, LlmProviderConfig>;
  provider_groups: Record<string, LlmProviderGroupConfig>;
  fallback: FallbackConfig;
  task_routing: Record<string, string>;
}

export interface AiConfig {
  asr: AsrConfig;
  llm: LlmConfig;
  web_search: WebSearchConfig;
  cc_bridge: CcBridgeConfig;
  codex_bridge: CodexBridgeConfig;
  acp_bridge: AcpBridgeConfig;
  full_local_mode?: boolean;
  fully_disabled?: boolean;
  /** Default output format for chat replies: "md" | "html" | "plain". */
  chat_output_format?: string;
  /** Composer send shortcut: "ctrl_enter" (default) | "enter". */
  chat_send_shortcut?: string;
}

export interface CcCustomSettingsProfile {
  id: string;
  name: string;
  enabled: boolean;
  vault_ref: string;
  created_at: number;
  proxy_mode?: "inherit" | "none" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
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
  proxy_mode?: "none" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
  custom_settings_profiles?: CcCustomSettingsProfile[];
  active_profile_id?: string;
}

export interface CodexCustomConfigProfile {
  id: string;
  name: string;
  enabled: boolean;
  vault_ref: string;
  created_at: number;
  proxy_mode?: "inherit" | "none" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
}

export interface CodexBridgeConfig {
  enabled: boolean;
  binary: string;
  min_version: string;
  default_model: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access" | string;
  approval_policy: "never" | "on-request" | "on-failure" | "untrusted" | string;
  network_access?: boolean;
  proxy_mode?: "none" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
  confirm_readonly?: boolean;
  terminal_echo_enabled?: boolean;
  custom_config_profiles?: CodexCustomConfigProfile[];
  active_profile_id?: string;
}

export interface AcpProfileConfig {
  id: string;
  name: string;
  enabled: boolean;
  command: string;
  args: string[];
  /**
   * Optional media features for the built-in Grok ACP profile. Other ACP
   * profiles remain chat-only until they have a dedicated media adapter.
   */
  capabilities?: AcpProfileCapabilities;
  auth_method_id?: string | null;
  proxy_mode: "inherit" | "direct" | "app" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
}

export interface AcpProfileCapabilities {
  image_generation?: boolean;
  video_generation?: boolean;
}

export interface AcpBridgeConfig {
  enabled: boolean;
  active_profile_id?: string | null;
  proxy_mode: "direct" | "app" | "session" | "manual" | string;
  proxy_session_id?: string | null;
  proxy_url?: string | null;
  request_timeout_seconds: number;
  profiles: AcpProfileConfig[];
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

export type LlmProviderCapability = "chat" | "image_generation" | "video_generation";

export type ChatDrawerProviderPreference = Partial<Record<LlmProviderCapability, string>>;

export interface AiStore {
  config: AiConfig | null;
  loading: boolean;
  saving: boolean;
  testResults: Record<string, TestConnectionResult | null>;
  voiceShellEnabled: boolean;

  loadConfig: () => Promise<void>;
  saveConfig: (config: AiConfig) => Promise<void>;
  updateLlmProvider: (id: string, provider: LlmProviderConfig) => void;
  updateLlmProviderGroup: (id: string, group: LlmProviderGroupConfig) => void;
  removeLlmProviderGroup: (id: string) => void;
  setActiveLlmProvider: (id: string) => void;
  testConnection: (providerId: string, provider: LlmProviderConfig) => Promise<void>;
  toggleVoiceShell: () => void;
}
