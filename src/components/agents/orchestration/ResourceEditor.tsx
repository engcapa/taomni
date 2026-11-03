import { useState, type ReactNode } from "react";
import type { AgentResource } from "../../../lib/ipc/orchestration";
import { useAiStore } from "../../../stores/aiStore";
import { AppProxyPanel } from "../../settings/AppProxyPanel";
import { defaultResourceProxy } from "./settingsModel";
import { useOrchT } from "./locales";

export function SettingsField({ name, label, children }: { name: string; label: string; children: ReactNode }) {
  return (
    <div className="orch-setting-row">
      <label htmlFor={`orch-${name}`}>{label}</label>{children}
    </div>
  );
}

interface Props {
  resource: AgentResource;
  onChange: (patch: Partial<AgentResource>) => void;
  onRemove: () => void;
}

export function ResourceEditor({ resource, onChange, onRemove }: Props) {
  const t = useOrchT();
  const config = useAiStore((state) => state.config);
  const providers = Object.entries(config?.llm.providers ?? {}).filter(([, provider]) =>
    provider.capabilities?.chat !== false,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const selectProvider = (id: string) => {
    setNotice(null);
    if (!id) { onChange({ providerId: "" }); return; }
    const provider = config?.llm.providers[id];
    if (!provider) return;
    const key = provider.api_keys?.find((value) => value.trim()) ?? provider.api_key;
    const safeKey = key?.startsWith("vault:") ? key : "";
    if (key && !safeKey && key !== "local") setNotice(t("invalidKey"));
    onChange({
      providerId: id,
      model: provider.model,
      baseUrl: provider.base_url,
      keyRef: safeKey,
      protocol: provider.runtime === "anthropic" ? "anthropic_messages" : "openai_chat",
    });
  };

  return (
    <section className="orch-resource-editor" data-testid="orch-resource-editor">
      <SettingsField name="resource-name" label={t("resourceName")}>
        <input
          id="orch-resource-name"
          data-testid="orch-resource-name"
          value={resource.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </SettingsField>
      <SettingsField name="resource-kind" label={t("resourceKind")}>
        <select
          id="orch-resource-kind"
          data-testid="orch-resource-kind"
          value={resource.kind}
          onChange={(event) => onChange({ kind: event.target.value as AgentResource["kind"] })}
        >
          <option value="api">{t("api")}</option><option value="worker">{t("worker")}</option>
        </select>
      </SettingsField>
      {resource.kind === "api" ? (
        <>
          <SettingsField name="resource-provider" label={t("provider")}>
            <select
              id="orch-resource-provider"
              data-testid="orch-resource-provider"
              value={resource.providerId}
              onChange={(event) => selectProvider(event.target.value)}
            >
              <option value="">{t("chooseProvider")}</option>
              {resource.providerId && !providers.some(([id]) => id === resource.providerId) && (
                <option value={resource.providerId}>{resource.providerId} · {t("unavailableProvider")}</option>
              )}
              {providers.map(([id]) => <option key={id} value={id}>{id}</option>)}
            </select>
          </SettingsField>
          <p className="orch-small-note">{t("providerHint")}</p>
          {notice && <p role="alert" className="orch-error">{notice}</p>}
          <SettingsField name="resource-address" label={t("endpoint")}>
            <input
              id="orch-resource-address"
              data-testid="orch-resource-address"
              spellCheck={false}
              value={resource.baseUrl}
              onChange={(event) => onChange({ baseUrl: event.target.value })}
            />
          </SettingsField>
          <SettingsField name="resource-model" label={t("model")}>
            <input
              id="orch-resource-model"
              data-testid="orch-resource-model"
              spellCheck={false}
              value={resource.model}
              onChange={(event) => onChange({ model: event.target.value })}
            />
          </SettingsField>
          <SettingsField name="resource-key" label={t("keyRef")}>
            <input
              id="orch-resource-key"
              data-testid="orch-resource-key"
              autoComplete="off"
              spellCheck={false}
              value={resource.keyRef}
              placeholder="vault:…"
              aria-invalid={!!resource.keyRef && !/^vault:\S+$/.test(resource.keyRef)}
              onChange={(event) => onChange({ keyRef: event.target.value })}
            />
          </SettingsField>
          <p className="orch-small-note">{t("keyHint")}</p>
        </>
      ) : (
        <>
          <SettingsField name="resource-harness" label={t("harness")}>
            <select
              id="orch-resource-harness"
              data-testid="orch-resource-harness"
              value={resource.harness}
              onChange={(event) => onChange({ harness: event.target.value as AgentResource["harness"] })}
            >
              <option value="claude_code">Claude Code</option><option value="codex">Codex</option>
              <option value="pi">Pi</option><option value="opencode">OpenCode</option>
              <option value="deepseek">DeepSeek</option><option value="zcode">ZCode</option>
            </select>
          </SettingsField>
          <SettingsField name="resource-binary" label={t("binary")}>
            <input
              id="orch-resource-binary"
              data-testid="orch-resource-binary"
              value={resource.binary}
              onChange={(event) => onChange({ binary: event.target.value })}
            />
          </SettingsField>
          <SettingsField name="resource-args" label={t("args")}>
            <textarea
              id="orch-resource-args"
              data-testid="orch-resource-args"
              rows={3}
              value={resource.args.join("\n")}
              onChange={(event) => onChange({ args: event.target.value ? event.target.value.split("\n") : [] })}
            />
          </SettingsField>
          <p className="orch-small-note">{t("workerHint")}</p>
        </>
      )}
      <details className="orch-resource-advanced">
        <summary>{t("advanced")}</summary>
        <SettingsField name="resource-protocol" label={t("protocol")}>
          <select
            id="orch-resource-protocol"
            data-testid="orch-resource-protocol"
            value={resource.protocol}
            onChange={(event) => onChange({ protocol: event.target.value as AgentResource["protocol"] })}
          >
            <option value="anthropic_messages">Anthropic Messages</option>
            <option value="openai_responses">OpenAI Responses</option>
            <option value="openai_chat">OpenAI Chat Completions</option>
          </select>
        </SettingsField>
        <SettingsField name="resource-cost" label={t("costCoefficient")}>
          <input
            id="orch-resource-cost"
            data-testid="orch-resource-cost"
            type="number"
            step="0.01"
            min="0.01"
            value={Number.isFinite(resource.costCoefficient) ? resource.costCoefficient : ""}
            onChange={(event) => onChange({ costCoefficient: Number(event.target.value) })}
          />
        </SettingsField>
      </details>
      <SettingsField name="resource-proxy" label={t("proxy")}>
        <select
          id="orch-resource-proxy"
          data-testid="orch-resource-proxy"
          value={resource.proxyMode}
          onChange={(event) => onChange({
            proxyMode: event.target.value as AgentResource["proxyMode"],
            customProxy: resource.customProxy ?? defaultResourceProxy(),
          })}
        >
          <option value="app">{t("proxyApp")}</option>
          <option value="custom">{t("proxyCustom")}</option>
          <option value="none">{t("proxyNone")}</option>
        </select>
      </SettingsField>
      <p className="orch-small-note">
        {t(resource.proxyMode === "app" ? "proxyAppHint" : resource.proxyMode === "none" ? "proxyNoneHint" : "proxyCustomHint")}
      </p>
      {resource.proxyMode === "custom" && (
        <div data-testid="orch-resource-custom-proxy" className="orch-custom-proxy">
          <AppProxyPanel
            value={resource.customProxy ?? defaultResourceProxy()}
            onSave={async (customProxy) => { onChange({ customProxy: { ...customProxy, enabled: true } }); }}
          />
        </div>
      )}
      <button type="button" className="orch-quiet" data-testid="orch-resource-remove" onClick={onRemove}>
        {t("removeResource")}
      </button>
    </section>
  );
}
