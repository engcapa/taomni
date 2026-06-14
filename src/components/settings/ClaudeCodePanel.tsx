import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle, Copy, Loader2, Terminal, XCircle, AlertTriangle } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
import {
  ccGetCustomSettings,
  vaultPut,
  vaultUpdate,
  vaultDelete,
  vaultStatus,
  isVaultLockedError,
  VAULT_LOCKED_EVENT,
} from "../../lib/ipc";

/** Starter shown in the editor the first time a user adds custom settings. */
const SETTINGS_TEMPLATE = `{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-key",
    "ANTHROPIC_BASE_URL": "https://url"
  },
  "permissions": {
    "allow": [
      "Bash",
      "Read",
      "Edit",
      "Write",
      "WebFetch",
      "Grep",
      "Glob",
      "LS"
    ],
    "defaultMode": "default"
  }
}`;

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
  const t = useT();

  useEffect(() => {
    if (!config) loadConfig();
  }, []);

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

  // --- Custom settings.json (advanced) ---
  const [customEditing, setCustomEditing] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const [customBusy, setCustomBusy] = useState(false);
  const [customSaved, setCustomSaved] = useState(false);

  const openAddCustom = () => {
    setCustomDraft(SETTINGS_TEMPLATE);
    setCustomError(null);
    setCustomEditing(true);
  };

  const openEditCustom = async () => {
    setCustomBusy(true);
    setCustomError(null);
    try {
      // Decrypt the stored settings from the vault for in-place editing.
      const json = await ccGetCustomSettings();
      setCustomDraft(json ?? SETTINGS_TEMPLATE);
      setCustomEditing(true);
    } catch (e) {
      // A locked vault already triggers the unlock prompt via the ipc wrapper.
      if (!isVaultLockedError(e)) setCustomError(String(e));
    } finally {
      setCustomBusy(false);
    }
  };

  const cancelEditCustom = () => {
    setCustomEditing(false);
    setCustomDraft("");
    setCustomError(null);
  };

  const saveCustom = async () => {
    if (!config) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(customDraft);
    } catch (e) {
      setCustomError(t("aiSettings.ccCustomInvalidJson", { error: (e as Error).message }));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setCustomError(t("aiSettings.ccCustomNotObject"));
      return;
    }
    const pretty = JSON.stringify(parsed, null, 2);

    setCustomBusy(true);
    setCustomError(null);
    try {
      // The settings JSON usually carries an auth token, so it must live in the
      // vault — never plaintext in ai.json. Require an unlocked vault first.
      const vstatus = await vaultStatus().catch(() => null);
      if (!vstatus || vstatus.state !== "unlocked") {
        window.dispatchEvent(
          new CustomEvent(VAULT_LOCKED_EVENT, {
            detail: { reason: t("aiSettings.ccCustomVaultRequired") },
          }),
        );
        setCustomError(t("aiSettings.ccCustomVaultRequired"));
        setCustomBusy(false);
        return;
      }

      let ref = cc.custom_settings_ref;
      if (ref && ref.startsWith("vault:")) {
        await vaultUpdate(ref.slice("vault:".length), pretty);
      } else {
        const res = await vaultPut("cc_bridge:settings", "Claude Code settings.json", pretty);
        ref = res.reference;
      }
      await saveConfig({ ...config, cc_bridge: { ...cc, custom_settings_ref: ref } });
      setCustomEditing(false);
      setCustomDraft("");
      setCustomSaved(true);
      setTimeout(() => setCustomSaved(false), 2500);
    } catch (e) {
      if (!isVaultLockedError(e)) setCustomError(String(e));
    } finally {
      setCustomBusy(false);
    }
  };

  const removeCustom = async () => {
    if (!config) return;
    setCustomBusy(true);
    setCustomError(null);
    try {
      const ref = cc.custom_settings_ref;
      await saveConfig({ ...config, cc_bridge: { ...cc, custom_settings_ref: undefined } });
      if (ref && ref.startsWith("vault:")) {
        try {
          await vaultDelete(ref.slice("vault:".length));
        } catch {
          // Entry may already be gone — clearing the reference is what matters.
        }
      }
    } catch (e) {
      setCustomError(String(e));
    } finally {
      setCustomBusy(false);
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

      {/* Ready — show config options */}
      {isReady && cc.enabled && (
        <div className="space-y-2 pt-2 border-t border-[var(--taomni-divider)]">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-[var(--taomni-text-muted)] block mb-1">{t("aiSettings.ccDefaultModel")}</label>
              <select
                className="taomni-input h-7 w-full text-[12px]"
                value={cc.default_model}
                onChange={(e) => saveConfig({ ...config, cc_bridge: { ...cc, default_model: e.target.value } })}
              >
                <option value="sonnet">{t("aiSettings.ccModelSonnet")}</option>
                <option value="opus">{t("aiSettings.ccModelOpus")}</option>
                <option value="haiku">{t("aiSettings.ccModelHaiku")}</option>
              </select>
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
          <div className="text-[10px] text-[var(--taomni-text-muted)]">
            {t("aiSettings.ccLocalModeNote")}
          </div>
        </div>
      )}

      {/* Custom settings.json (advanced) */}
      {cc.enabled && (
        <div className="space-y-2 pt-2 border-t border-[var(--taomni-divider)]">
          <div>
            <div className="text-[12px] font-semibold">{t("aiSettings.ccCustomTitle")}</div>
            <div className="text-[11px] text-[var(--taomni-text-muted)]">
              {t("aiSettings.ccCustomSubtitle")}
            </div>
          </div>

          {!customEditing && !cc.custom_settings_ref && (
            <button
              type="button"
              className="taomni-btn h-7 px-3 text-[12px]"
              disabled={customBusy}
              onClick={openAddCustom}
            >
              {t("aiSettings.ccCustomAdd")}
            </button>
          )}

          {!customEditing && cc.custom_settings_ref && (
            <div className="flex items-center gap-2">
              {/* enable/disable toggle — keeps the vault entry intact */}
              <div
                className={`w-8 h-4 rounded-full transition-colors relative cursor-pointer shrink-0 ${
                  cc.custom_settings_enabled !== false
                    ? "bg-[var(--taomni-accent)]"
                    : "bg-[var(--taomni-divider)]"
                }`}
                onClick={() =>
                  saveConfig({
                    ...config,
                    cc_bridge: {
                      ...cc,
                      custom_settings_enabled: cc.custom_settings_enabled === false,
                    },
                  })
                }
                title={
                  cc.custom_settings_enabled !== false
                    ? t("aiSettings.ccCustomEnabled")
                    : t("aiSettings.ccCustomDisabled")
                }
              >
                <div
                  className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                    cc.custom_settings_enabled !== false ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </div>
              <CheckCircle
                className={`w-3.5 h-3.5 shrink-0 ${
                  cc.custom_settings_enabled !== false ? "text-green-400" : "text-[var(--taomni-text-muted)]"
                }`}
              />
              <span className="text-[11px] flex-1">
                {t("aiSettings.ccCustomConfigured")}
                {cc.custom_settings_enabled === false && (
                  <span className="ml-1 text-[var(--taomni-text-muted)]">
                    · {t("aiSettings.ccCustomDisabled")}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
                disabled={customBusy}
                onClick={openEditCustom}
              >
                {customBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : t("aiSettings.ccCustomEdit")}
              </button>
              <button
                type="button"
                className="taomni-btn h-6 px-2 text-[11px] text-red-400"
                disabled={customBusy}
                onClick={removeCustom}
              >
                {t("aiSettings.ccCustomRemove")}
              </button>
            </div>
          )}

          {customEditing && (
            <div className="space-y-2">
              <textarea
                className="taomni-input w-full font-mono text-[11px] leading-relaxed"
                style={{ minHeight: 220 }}
                spellCheck={false}
                value={customDraft}
                onChange={(e) => setCustomDraft(e.target.value)}
                placeholder={t("aiSettings.ccCustomPlaceholder")}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="taomni-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
                  disabled={customBusy}
                  onClick={saveCustom}
                >
                  {customBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  {t("aiSettings.ccCustomSave")}
                </button>
                <button
                  type="button"
                  className="taomni-btn h-7 px-3 text-[12px]"
                  disabled={customBusy}
                  onClick={cancelEditCustom}
                >
                  {t("aiSettings.ccCustomCancel")}
                </button>
              </div>
            </div>
          )}

          {customError && (
            <div className="text-[11px] text-red-400 rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5">
              {customError}
            </div>
          )}
          {customSaved && (
            <div className="text-[11px] text-green-400">{t("aiSettings.ccCustomSaved")}</div>
          )}
          <div className="text-[10px] text-[var(--taomni-text-muted)]">
            {t("aiSettings.ccCustomNote")}
          </div>
        </div>
      )}
    </div>
  );
}
