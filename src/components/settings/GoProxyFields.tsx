import type { LlmProviderConfig } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
import { AppProxyPanel } from "./AppProxyPanel";
import { CodexProxyFields } from "./CodexProxyFields";

const DEFAULT_CUSTOM_PROXY = {
  enabled: true, mode: "manual", session_id: "", kind: "http",
  host: "", port: 3128, username: "", password_ref: "",
};

export function GoProxyFields({ provider, onChange }: {
  provider: LlmProviderConfig;
  onChange: (provider: LlmProviderConfig) => void;
}) {
  const t = useT();
  const mode = provider.proxy_mode || "app";
  const legacy = mode === "session" || mode === "manual";
  return <div className="space-y-2">
    <select data-testid="go-proxy-mode" aria-label={t("aiSettings.codexProxyTitle")}
      className="taomni-input w-full" value={mode}
      onChange={(e) => onChange({ ...provider, proxy_mode: e.target.value })}>
      <option value="app">{t("voice.proxyApp")}</option>
      <option value="custom">{t("voice.proxyCustom")}</option>
      <option value="none">{t("aiSettings.codexProxyNone")}</option>
      {legacy && <option value={mode}>{t(mode === "session" ? "settings.appProxyModeSession" : "settings.appProxyModeManual")}</option>}
    </select>
    {mode === "custom" && <div data-testid="go-custom-proxy">
      <AppProxyPanel value={provider.custom_proxy ?? DEFAULT_CUSTOM_PROXY}
        onSave={async (custom_proxy) => onChange({ ...provider, custom_proxy })}
        testHost="opencode.ai" />
    </div>}
    {legacy && <CodexProxyFields mode={mode} sessionId={provider.proxy_session_id}
      proxyUrl={provider.proxy_url} onChange={(patch) => onChange({ ...provider, ...patch })} />}
  </div>;
}
