import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./defaults";
import { taoDefaults, taoProviderOptions } from "./taoProviders";

function config() { return structuredClone(DEFAULT_CONFIG); }

describe("Tao configured ordinary LLM providers", () => {
  it("excludes harnesses, groups, media-only providers and unknown runtimes", () => {
    const value = config();
    const base = value.llm.providers.deepseek;
    value.llm.providers = {
      custom: { ...base, model: "custom-model", runtime: "openai-compat" },
      claude: { ...base, runtime: "anthropic" },
      "claude-code": { ...base }, codex: { ...base }, "acp:profile": { ...base }, "group:roundrobin": { ...base },
      image: { ...base, capabilities: { chat: false, image_generation: true } },
      harness: { ...base, runtime: "claude-cli" },
    };
    expect(taoProviderOptions(value).map((provider) => provider.id)).toEqual(["custom", "claude"]);
    const option = taoProviderOptions(value)[0];
    expect(option).toMatchObject({ model: "custom-model", models: ["custom-model"] });
    expect(option.capabilities("custom-model")).toMatchObject({ thinking: false, web: false });
  });

  it("allows keyless loopback, blocks cloud in local mode and respects AI disabled", () => {
    const value = config();
    const base = value.llm.providers.local;
    value.llm.providers = {
      local: { ...base, api_key: "", model: "qwen-local", base_url: "http://127.0.0.1:8080/v1" },
      custom: { ...base, runtime: "openai-compat", api_key: "vault:key", base_url: "https://cloud.example/v1" },
      trick: { ...base, base_url: "http://127.0.0.1.example.invalid/v1" },
    };
    value.full_local_mode = true;
    expect(taoProviderOptions(value)).toEqual([expect.objectContaining({ id: "local", ready: true })]);
    value.fully_disabled = true;
    expect(taoProviderOptions(value)).toEqual([]);
  });

  it("uses the configured default model without DeepSeek coercion and safely replaces a removed provider", () => {
    const value = config();
    value.llm.providers.custom = { ...value.llm.providers.deepseek, model: "configured/model" };
    value.deepseek_app = { ...value.deepseek_app!, provider: "custom", model: "thread-default-v2", thinking_default: true, search_default: true };
    expect(taoDefaults(value)).toMatchObject({ defaultProvider: "custom", defaultModel: "thread-default-v2", defaultThinking: false, defaultWeb: false });
    delete value.llm.providers.custom;
    expect(taoDefaults(value)).toMatchObject({ defaultProvider: value.llm.active, defaultModel: value.llm.providers[value.llm.active].model });
  });
});
