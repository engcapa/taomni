import { useEffect, useState } from "react";
import { CheckCircle, XCircle, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { useAiStore, type LlmProviderConfig } from "../../stores/aiStore";

const PROVIDER_LABELS: Record<string, string> = {
  deepseek:    "DeepSeek",
  glm:         "GLM-4-Flash (免费)",
  siliconflow: "SiliconFlow",
  groq:        "Groq",
  local:       "本地 (llama-server)",
};

const PROVIDER_NOTES: Record<string, string> = {
  deepseek:    "~¥1/百万输入，中文优秀",
  glm:         "完全免费，国内首选",
  siliconflow: "一 Key 多模型，大量小模型免费",
  groq:        "极速推理 ~500 tok/s，免费层",
  local:       "零成本，需下载模型 (~1.4 GB)",
};

interface ProviderRowProps {
  id: string;
  provider: LlmProviderConfig;
  isActive: boolean;
  onActivate: () => void;
  onChange: (p: LlmProviderConfig) => void;
  onTest: () => void;
  testResult: { ok: boolean; message: string; latency_ms: number } | null;
  testing: boolean;
}

function ProviderRow({ id, provider, isActive, onActivate, onChange, onTest, testResult, testing }: ProviderRowProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`rounded border transition-colors ${
        isActive
          ? "border-[var(--moba-accent)] bg-[var(--moba-accent)]/5"
          : "border-[var(--moba-divider)] bg-[var(--moba-bg)]"
      }`}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-[var(--moba-text-muted)] shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-[var(--moba-text-muted)] shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium">{PROVIDER_LABELS[id] ?? id}</div>
          <div className="text-[11px] text-[var(--moba-text-muted)] truncate">
            {PROVIDER_NOTES[id] ?? provider.base_url}
          </div>
        </div>

        {testResult && (
          <span className={`text-[11px] ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
            {testResult.ok ? `✓ ${testResult.latency_ms}ms` : "✗ 失败"}
          </span>
        )}

        <button
          type="button"
          className={`moba-btn h-6 px-2 text-[11px] shrink-0 ${isActive ? "opacity-50 cursor-default" : ""}`}
          onClick={(e) => { e.stopPropagation(); if (!isActive) onActivate(); }}
          disabled={isActive}
        >
          {isActive ? "当前" : "使用"}
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 border-t border-[var(--moba-divider)] pt-2 space-y-2">
          {id !== "local" && (
            <div>
              <label className="text-[11px] text-[var(--moba-text-muted)] block mb-1">API Key</label>
              <input
                type="password"
                className="moba-input h-7 w-full text-[12px]"
                placeholder="粘贴 API Key..."
                value={provider.api_key}
                onChange={(e) => onChange({ ...provider, api_key: e.target.value })}
              />
            </div>
          )}
          <div>
            <label className="text-[11px] text-[var(--moba-text-muted)] block mb-1">模型</label>
            <input
              type="text"
              className="moba-input h-7 w-full text-[12px]"
              value={provider.model}
              onChange={(e) => onChange({ ...provider, model: e.target.value })}
            />
          </div>
          <div>
            <label className="text-[11px] text-[var(--moba-text-muted)] block mb-1">Base URL</label>
            <input
              type="text"
              className="moba-input h-7 w-full text-[12px]"
              value={provider.base_url}
              onChange={(e) => onChange({ ...provider, base_url: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              className="moba-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
              onClick={onTest}
              disabled={testing}
            >
              {testing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                "测试连接"
              )}
            </button>
            {testResult && (
              <span className={`text-[12px] flex items-center gap-1 ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
                {testResult.ok ? (
                  <><CheckCircle className="w-3.5 h-3.5" /> 连接成功 ({testResult.latency_ms}ms)</>
                ) : (
                  <><XCircle className="w-3.5 h-3.5" /> {testResult.message.slice(0, 60)}</>
                )}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function LlmProvidersPanel() {
  const { config, loading, saving, testResults, loadConfig, saveConfig, updateLlmProvider, setActiveLlmProvider, testConnection } = useAiStore();
  const [testingId, setTestingId] = useState<string | null>(null);

  useEffect(() => {
    if (!config) loadConfig();
  }, []);

  if (loading || !config) {
    return <div className="text-[12px] text-[var(--moba-text-muted)] p-3">加载中...</div>;
  }

  const handleTest = async (id: string) => {
    const provider = config.llm.providers[id];
    if (!provider) return;
    setTestingId(id);
    await testConnection(id, provider);
    setTestingId(null);
  };

  const handleSave = async () => {
    try {
      await saveConfig(config);
    } catch (e) {
      console.error("Failed to save AI config:", e);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-1">
        <div>
          <div className="text-[13px] font-semibold">LLM Provider</div>
          <div className="text-[11px] text-[var(--moba-text-muted)]">
            当前: {config.llm.active} · 超时回退: {config.llm.fallback.enabled ? `${config.llm.fallback.timeout_ms}ms → ${config.llm.fallback.secondary}` : "关闭"}
          </div>
        </div>
        <button
          type="button"
          className="moba-btn h-7 px-3 text-[12px]"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>

      {Object.entries(config.llm.providers).map(([id, provider]) => (
        <ProviderRow
          key={id}
          id={id}
          provider={provider}
          isActive={config.llm.active === id}
          onActivate={() => setActiveLlmProvider(id)}
          onChange={(p) => updateLlmProvider(id, p)}
          onTest={() => handleTest(id)}
          testResult={testResults[id] ?? null}
          testing={testingId === id}
        />
      ))}
    </div>
  );
}
