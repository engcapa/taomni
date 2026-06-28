import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle, Copy, Loader2, Terminal, XCircle, AlertTriangle } from "lucide-react";
import { DEFAULT_CLAUDE_CODE_MODEL, useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
import { useVaultGate } from "../../lib/vaultGate";
import { ClaudeCodeSettingsDialog } from "./ClaudeCodeSettingsDialog";
import { Sliders, Shield } from "lucide-react";
import { CodexProxyFields } from "./CodexProxyFields";

interface CcStatusResult {
  status:
    | { type: "not_found" }
    | { type: "version_too_low"; found: string; required: string }
    | { type: "not_authenticated" }
    | { type: "ready"; version: string };
  message: string;
  binary_path: string | null;
}

const INSTALL_COMMANDS = [
  { platform: "Windows (winget)", cmd: "winget install Anthropic.Claude" },
  { platform: "macOS (Homebrew)", cmd: "brew install anthropic/claude/claude" },
  { platform: "npm (all platforms)", cmd: "npm install -g @anthropic-ai/claude-code" },
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

export function ClaudeCodePanel() {
  const { config, loadConfig, saveConfig } = useAiStore();
  const [status, setStatus] = useState<CcStatusResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [showCustomDialog, setShowCustomDialog] = useState(false);
  const [openingCustomDialog, setOpeningCustomDialog] = useState(false);
  const [defaultModelDraft, setDefaultModelDraft] = useState(DEFAULT_CLAUDE_CODE_MODEL);
  const t = useT();
  const ensureVaultReady = useVaultGate();

  useEffect(() => {
    if (!config) loadConfig();
  }, []);

  useEffect(() => {
    if (config) {
      setDefaultModelDraft(config.cc_bridge.default_model?.trim() || DEFAULT_CLAUDE_CODE_MODEL);
    }
  }, [config?.cc_bridge.default_model]);

  const handleDetect = async () => {
    setDetecting(true);
    try {
      const result = await invoke<CcStatusResult>("cc_detect");
      setStatus(result);
    } catch (e) {
      setStatus({
        status: { type: "not_found" },
        message: String(e),
        binary_path: null,
      });
    } finally {
      setDetecting(false);
    }
  };

  if (!config) return null;

  const cc = config.cc_bridge;
  const isReady = status?.status.type === "ready";
  const isNotFound = !status || status.status.type === "not_found";
  const isVersionLow = status?.status.type === "version_too_low";
  const isNotAuth = status?.status.type === "not_authenticated";

  const StatusIcon = () => {
    if (!status) return <Terminal className="w-4 h-4 text-[var(--taomni-text-muted)]" />;
    if (isReady) return <CheckCircle className="w-4 h-4 text-green-400" />;
    if (isNotAuth) return <AlertTriangle className="w-4 h-4 text-yellow-400" />;
    return <XCircle className="w-4 h-4 text-red-400" />;
  };

  const hasProfiles = cc.custom_settings_profiles && cc.custom_settings_profiles.length > 0;
  const profileCount = cc.custom_settings_profiles?.length ?? 0;

  const commitDefaultModel = () => {
    const next = defaultModelDraft.trim() || DEFAULT_CLAUDE_CODE_MODEL;
    setDefaultModelDraft(next);
    if (next === cc.default_model) return;
    void saveConfig({
      ...config,
      cc_bridge: { ...cc, default_model: next },
    }).catch((e) => {
      console.warn("save Claude Code default model failed:", e);
      setDefaultModelDraft(cc.default_model?.trim() || DEFAULT_CLAUDE_CODE_MODEL);
    });
  };

  const openCustomDialog = async () => {
    if (openingCustomDialog) return;
    setOpeningCustomDialog(true);
    try {
      const ready = await ensureVaultReady(t("aiSettings.ccCustomVaultRequired"));
      if (ready) {
        setShowCustomDialog(true);
      }
    } finally {
      setOpeningCustomDialog(false);
    }
  };

  const activeProfileName = (() => {
    if (cc.active_profile_id && cc.custom_settings_profiles) {
      const active = cc.custom_settings_profiles.find(p => p.id === cc.active_profile_id);
      if (active) return active.name;
    }
    return null;
  })();

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[13px] font-semibold">{t("aiSettings.ccTitle")}</div>
        <div className="text-[11px] text-[var(--taomni-text-muted)]">
          {t("aiSettings.ccSubtitle")}
        </div>
      </div>

      {/* Enable toggle */}
      <div
        className={`flex items-center gap-3 rounded border p-3 cursor-pointer transition-colors ${
          cc.enabled
            ? "border-[var(--taomni-accent)]/40 bg-[var(--taomni-accent)]/5"
            : "border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
        }`}
        onClick={() => saveConfig({ ...config, cc_bridge: { ...cc, enabled: !cc.enabled } })}
      >
        <StatusIcon />
        <div className="flex-1">
          <div className="text-[13px] font-semibold">
            {t("aiSettings.ccTitle")} {cc.enabled ? t("aiSettings.ccEnabledSuffix") : ""}
          </div>
          <div className="text-[11px] text-[var(--taomni-text-muted)]">
            {status?.message ?? t("aiSettings.ccDefaultMessage")}
          </div>
        </div>
        <div className={`w-9 h-5 rounded-full transition-colors relative ${cc.enabled ? "bg-[var(--taomni-accent)]" : "bg-[var(--taomni-divider)]"}`}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${cc.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </div>
      </div>

      {/* Detect button */}
      <button
        type="button"
        className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
        onClick={handleDetect}
        disabled={detecting}
      >
        {detecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Terminal className="w-3.5 h-3.5" />}
        {t("aiSettings.ccDetect")}
      </button>

      {/* Install instructions (shown when not found) */}
      {isNotFound && (
        <div className="rounded border border-[var(--taomni-divider)] p-3 space-y-2">
          <div className="text-[12px] font-semibold">{t("aiSettings.ccInstallTitle")}</div>
          {INSTALL_COMMANDS.map(({ platform, cmd }) => (
            <div key={platform}>
              <div className="text-[10px] text-[var(--taomni-text-muted)] mb-0.5">{platform}</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-[11px] bg-[var(--taomni-bg)] rounded px-2 py-1 truncate">
                  {cmd}
                </code>
                <CopyButton text={cmd} />
              </div>
            </div>
          ))}

          {/* Manual binary path — fallback when claude isn't on the GUI PATH */}
          <div className="pt-2 mt-1 border-t border-[var(--taomni-divider)]">
            <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">
              {t("aiSettings.ccManualPathLabel")}
            </label>
            <input
              type="text"
              className="taomni-input h-7 w-full text-[12px] font-mono"
              placeholder={t("aiSettings.ccManualPathPlaceholder")}
              defaultValue={cc.binary === "auto" ? "" : cc.binary}
              onBlur={(e) => {
                const v = e.target.value.trim();
                const next = v === "" ? "auto" : v;
                if (next !== cc.binary) {
                  saveConfig({ ...config, cc_bridge: { ...cc, binary: next } });
                }
              }}
            />
            <div className="text-[10px] text-[var(--taomni-text-muted)] mt-1">
              {t("aiSettings.ccManualPathHint")}
            </div>
          </div>
        </div>
      )}

      {/* Version too low */}
      {isVersionLow && status?.status.type === "version_too_low" && (
        <div className="text-[11px] text-yellow-400 rounded border border-yellow-500/30 bg-yellow-500/5 px-2 py-1.5">
          {t("aiSettings.ccVersionLow", { found: status.status.found, required: status.status.required, cmd: "npm update -g @anthropic-ai/claude-code" })}
        </div>
      )}

      {/* Not authenticated */}
      {isNotAuth && (
        <div className="flex items-center gap-2 text-[11px] text-yellow-400 rounded border border-yellow-500/30 bg-yellow-500/5 px-2 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{t("aiSettings.ccNotAuthenticated", { cmd: "claude login" })}</span>
        </div>
      )}

      {/* Enabled: show config options even before a detection pass. */}
      {cc.enabled && (
        <div className="space-y-2 pt-2 border-t border-[var(--taomni-divider)]">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.ccDefaultModel")}</label>
              <input
                type="text"
                className="taomni-input h-7 w-full text-[12px] font-mono"
                value={defaultModelDraft}
                placeholder={DEFAULT_CLAUDE_CODE_MODEL}
                spellCheck={false}
                onChange={(e) => setDefaultModelDraft(e.target.value)}
                onBlur={commitDefaultModel}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    setDefaultModelDraft(cc.default_model?.trim() || DEFAULT_CLAUDE_CODE_MODEL);
                    e.currentTarget.blur();
                  }
                }}
              />
            </div>
            <div>
              <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.ccMaxTurns")}</label>
              <input
                type="number"
                className="taomni-input h-7 w-full text-[12px]"
                min={1}
                max={50}
                value={cc.max_turns}
                onChange={(e) => saveConfig({ ...config, cc_bridge: { ...cc, max_turns: parseInt(e.target.value) || 20 } })}
              />
            </div>
          </div>
          <div>
            <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.codexProxyTitle")}</label>
            <CodexProxyFields
              mode={cc.proxy_mode}
              sessionId={cc.proxy_session_id}
              proxyUrl={cc.proxy_url}
              onChange={(patch) => saveConfig({ ...config, cc_bridge: { ...cc, ...patch } })}
            />
          </div>
          <div className="text-[10px] text-[var(--taomni-text-muted)]">
            {t("aiSettings.ccLocalModeNote")}
          </div>
          <label className="flex items-start gap-2 text-[11px] cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={cc.confirm_readonly ?? false}
              onChange={(e) =>
                saveConfig({ ...config, cc_bridge: { ...cc, confirm_readonly: e.target.checked } })
              }
            />
            <span>
              <span className="block">{t("aiSettings.ccConfirmReadonly")}</span>
              <span className="block text-[10px] text-[var(--taomni-text-muted)]">
                {t("aiSettings.ccConfirmReadonlyHint")}
              </span>
            </span>
          </label>
        </div>
      )}

      {/* Custom settings.json (advanced) */}
      {cc.enabled && (
        <div className="space-y-3 pt-2 border-t border-[var(--taomni-divider)]">
          <div>
            <div className="text-[12px] font-semibold">{t("aiSettings.ccCustomTitle")}</div>
            <div className="text-[11px] text-[var(--taomni-text-muted)]">
              {t("aiSettings.ccCustomSubtitle")}
            </div>
          </div>

          <div className="rounded border border-[var(--taomni-divider)] p-3 bg-[var(--taomni-panel-bg)]/50 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[11.5px]">
              <div className="flex items-center gap-1.5 min-w-0">
                <Shield className="w-3.5 h-3.5 text-green-400 shrink-0" />
                <span className="font-medium">
                  {hasProfiles
                    ? t("aiSettings.ccCustomProfilesSummary", { count: profileCount })
                    : t("aiSettings.ccCustomDisabled")}
                </span>
              </div>
              <button
                type="button"
                className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1 shrink-0"
                onClick={() => void openCustomDialog()}
                disabled={openingCustomDialog}
              >
                {openingCustomDialog ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sliders className="w-3 h-3" />}
                {t("aiSettings.ccCustomManage")}
              </button>
            </div>

            {hasProfiles && activeProfileName && (
              <div className="text-[10.5px] text-[var(--taomni-text-muted)] flex items-center gap-1">
                <span className="px-1 text-[8px] bg-green-500/15 text-green-400 border border-green-500/35 rounded uppercase shrink-0 font-medium">
                  {t("aiSettings.ccCustomActiveLabel")}
                </span>
                <span className="truncate">{activeProfileName}</span>
              </div>
            )}
          </div>

          <div className="text-[10px] text-[var(--taomni-text-muted)]">
            {t("aiSettings.ccCustomNote")}
          </div>
        </div>
      )}

      {showCustomDialog && (
        <ClaudeCodeSettingsDialog onClose={() => setShowCustomDialog(false)} />
      )}
    </div>
  );
}
