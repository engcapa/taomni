import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CheckCircle, Copy, Loader2, Sliders, Terminal, XCircle } from "lucide-react";
import { DEFAULT_CODEX_MODEL, useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
import { useVaultGate } from "../../lib/vaultGate";
import { CodexCodeConfigDialog } from "./CodexCodeConfigDialog";
import { CodexProxyFields } from "./CodexProxyFields";

interface CodexStatusResult {
  status:
    | { type: "not_found" }
    | { type: "version_too_low"; found: string; required: string }
    | { type: "not_authenticated" }
    | { type: "ready"; version: string };
  message: string;
  binary_path: string | null;
}

const INSTALL_COMMANDS = [
  { platform: "npm", cmd: "npm install -g @openai/codex" },
  { platform: "Homebrew", cmd: "brew install codex" },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const t = useT();
  return (
    <button
      type="button"
      className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center shrink-0"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={t("aiSettings.ccCopy")}
    >
      <Copy className={`w-3 h-3 ${copied ? "text-green-400" : ""}`} />
    </button>
  );
}

export function CodexCodePanel() {
  const { config, loadConfig, saveConfig } = useAiStore();
  const [status, setStatus] = useState<CodexStatusResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [openingDialog, setOpeningDialog] = useState(false);
  const [modelDraft, setModelDraft] = useState(DEFAULT_CODEX_MODEL);
  const t = useT();
  const ensureVaultReady = useVaultGate();

  useEffect(() => {
    if (!config) void loadConfig();
  }, []);

  useEffect(() => {
    if (config) setModelDraft(config.codex_bridge.default_model?.trim() || DEFAULT_CODEX_MODEL);
  }, [config?.codex_bridge.default_model]);

  if (!config) return null;
  const codex = config.codex_bridge;
  const ready = status?.status.type === "ready";
  const notFound = !status || status.status.type === "not_found";
  const versionLow = status?.status.type === "version_too_low";
  const notAuth = status?.status.type === "not_authenticated";
  const profiles = codex.custom_config_profiles ?? [];
  const activeProfile = profiles.find((p) => p.id === codex.active_profile_id);

  const detect = async () => {
    setDetecting(true);
    try {
      setStatus(await invoke<CodexStatusResult>("codex_detect"));
    } catch (e) {
      setStatus({ status: { type: "not_found" }, message: String(e), binary_path: null });
    } finally {
      setDetecting(false);
    }
  };

  const commitModel = () => {
    const next = modelDraft.trim() || DEFAULT_CODEX_MODEL;
    setModelDraft(next);
    if (next === codex.default_model) return;
    void saveConfig({ ...config, codex_bridge: { ...codex, default_model: next } }).catch(() =>
      setModelDraft(codex.default_model?.trim() || DEFAULT_CODEX_MODEL),
    );
  };

  const openConfigDialog = async () => {
    if (openingDialog) return;
    setOpeningDialog(true);
    try {
      const ready = await ensureVaultReady(t("aiSettings.codexCustomVaultRequired"));
      if (ready) {
        setShowDialog(true);
      }
    } finally {
      setOpeningDialog(false);
    }
  };

  const StatusIcon = () => {
    if (!status) return <Terminal className="w-4 h-4 text-[var(--taomni-text-muted)]" />;
    if (ready) return <CheckCircle className="w-4 h-4 text-green-400" />;
    if (notAuth) return <AlertTriangle className="w-4 h-4 text-yellow-400" />;
    return <XCircle className="w-4 h-4 text-red-400" />;
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[13px] font-semibold">{t("aiSettings.codexTitle")}</div>
        <div className="text-[11px] text-[var(--taomni-text-muted)]">{t("aiSettings.codexSubtitle")}</div>
      </div>

      <div
        className={`flex items-center gap-3 rounded border p-3 cursor-pointer transition-colors ${
          codex.enabled
            ? "border-[var(--taomni-accent)]/40 bg-[var(--taomni-accent)]/5"
            : "border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
        }`}
        onClick={() => saveConfig({ ...config, codex_bridge: { ...codex, enabled: !codex.enabled } })}
      >
        <StatusIcon />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold">
            Codex {codex.enabled ? t("aiSettings.ccEnabledSuffix") : ""}
          </div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
            {status?.message ?? t("aiSettings.codexDefaultMessage")}
          </div>
        </div>
        <div className={`w-9 h-5 rounded-full transition-colors relative ${codex.enabled ? "bg-[var(--taomni-accent)]" : "bg-[var(--taomni-divider)]"}`}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${codex.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </div>
      </div>

      <button type="button" className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5" onClick={detect} disabled={detecting}>
        {detecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Terminal className="w-3.5 h-3.5" />}
        {t("aiSettings.codexDetect")}
      </button>

      {notFound && (
        <div className="rounded border border-[var(--taomni-divider)] p-3 space-y-2">
          <div className="text-[12px] font-semibold">{t("aiSettings.codexInstallTitle")}</div>
          {INSTALL_COMMANDS.map(({ platform, cmd }) => (
            <div key={platform}>
              <div className="text-[10px] text-[var(--taomni-text-muted)] mb-0.5">{platform}</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-[11px] bg-[var(--taomni-bg)] rounded px-2 py-1 truncate">{cmd}</code>
                <CopyButton text={cmd} />
              </div>
            </div>
          ))}
          <div className="pt-2 mt-1 border-t border-[var(--taomni-divider)]">
            <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">
              {t("aiSettings.codexManualPathLabel")}
            </label>
            <input
              type="text"
              className="taomni-input h-7 w-full text-[12px] font-mono"
              placeholder={t("aiSettings.codexManualPathPlaceholder")}
              defaultValue={codex.binary === "auto" ? "" : codex.binary}
              onBlur={(e) => {
                const next = e.target.value.trim() || "auto";
                if (next !== codex.binary) {
                  void saveConfig({ ...config, codex_bridge: { ...codex, binary: next } });
                }
              }}
            />
          </div>
        </div>
      )}

      {versionLow && status?.status.type === "version_too_low" && (
        <div className="text-[11px] text-yellow-400 rounded border border-yellow-500/30 bg-yellow-500/5 px-2 py-1.5">
          {t("aiSettings.codexVersionLow", { found: status.status.found, required: status.status.required })}
        </div>
      )}
      {notAuth && (
        <div className="flex items-center gap-2 text-[11px] text-yellow-400 rounded border border-yellow-500/30 bg-yellow-500/5 px-2 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{t("aiSettings.codexNotAuthenticated", { cmd: "codex login" })}</span>
        </div>
      )}

      {codex.enabled && (
        <div className="space-y-3 pt-2 border-t border-[var(--taomni-divider)]">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.ccDefaultModel")}</label>
              <input
                type="text"
                className="taomni-input h-7 w-full text-[12px] font-mono"
                value={modelDraft}
                placeholder={DEFAULT_CODEX_MODEL}
                spellCheck={false}
                onChange={(e) => setModelDraft(e.target.value)}
                onBlur={commitModel}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    setModelDraft(codex.default_model?.trim() || DEFAULT_CODEX_MODEL);
                    e.currentTarget.blur();
                  }
                }}
              />
            </div>
            <div>
              <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.codexProxyTitle")}</label>
              <CodexProxyFields
                mode={codex.proxy_mode}
                sessionId={codex.proxy_session_id}
                proxyUrl={codex.proxy_url}
                onChange={(patch) => saveConfig({ ...config, codex_bridge: { ...codex, ...patch } })}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">Sandbox</label>
              <select
                className="taomni-input h-7 w-full text-[12px]"
                value={codex.sandbox}
                onChange={(e) => saveConfig({ ...config, codex_bridge: { ...codex, sandbox: e.target.value } })}
              >
                <option value="read-only">read-only</option>
                <option value="workspace-write">workspace-write</option>
                <option value="danger-full-access">danger-full-access</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">Approval</label>
              <select
                className="taomni-input h-7 w-full text-[12px]"
                value={codex.approval_policy}
                onChange={(e) => saveConfig({ ...config, codex_bridge: { ...codex, approval_policy: e.target.value } })}
              >
                <option value="never">never</option>
                <option value="on-request">on-request</option>
                <option value="on-failure">on-failure</option>
                <option value="untrusted">untrusted</option>
              </select>
            </div>
            <label className="flex items-end gap-2 text-[11px] cursor-pointer pb-1">
              <input
                type="checkbox"
                checked={codex.network_access ?? false}
                onChange={(e) => saveConfig({ ...config, codex_bridge: { ...codex, network_access: e.target.checked } })}
              />
              {t("aiSettings.codexNetworkAccess")}
            </label>
          </div>

          <label className="flex items-start gap-2 text-[11px] cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={codex.confirm_readonly ?? false}
              onChange={(e) => saveConfig({ ...config, codex_bridge: { ...codex, confirm_readonly: e.target.checked } })}
            />
            <span>
              <span className="block">{t("aiSettings.ccConfirmReadonly")}</span>
              <span className="block text-[10px] text-[var(--taomni-text-muted)]">
                {t("aiSettings.codexConfirmReadonlyHint")}
              </span>
            </span>
          </label>

          <div className="rounded border border-[var(--taomni-divider)] p-3 bg-[var(--taomni-panel-bg)]/50 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold">{t("aiSettings.codexCustomTitle")}</div>
              <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
                {profiles.length > 0
                  ? t("aiSettings.codexCustomProfilesSummary", {
                      count: profiles.length,
                      name: activeProfile?.name ?? t("aiSettings.codexCustomNoActive"),
                    })
                  : t("aiSettings.codexCustomDisabled")}
              </div>
            </div>
            <button
              type="button"
              className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1 shrink-0"
              onClick={() => void openConfigDialog()}
              disabled={openingDialog}
            >
              {openingDialog ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sliders className="w-3 h-3" />}
              {t("aiSettings.ccCustomManage")}
            </button>
          </div>
          <div className="text-[10px] text-[var(--taomni-text-muted)]">{t("aiSettings.codexProxyPriorityNote")}</div>
        </div>
      )}

      {showDialog && <CodexCodeConfigDialog onClose={() => setShowDialog(false)} />}
    </div>
  );
}
