import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle, Copy, Loader2, Terminal, XCircle, AlertTriangle } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";

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
  return (
    <button
      type="button"
      className="moba-btn h-6 w-6 p-0 inline-flex items-center justify-center shrink-0"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title="Copy"
    >
      <Copy className={`w-3 h-3 ${copied ? "text-green-400" : ""}`} />
    </button>
  );
}

export function ClaudeCodePanel() {
  const { config, loadConfig, saveConfig } = useAiStore();
  const [status, setStatus] = useState<CcStatusResult | null>(null);
  const [detecting, setDetecting] = useState(false);

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

  if (!config) return null;

  const cc = config.cc_bridge;
  const isReady = status?.status.type === "ready";
  const isNotFound = !status || status.status.type === "not_found";
  const isVersionLow = status?.status.type === "version_too_low";
  const isNotAuth = status?.status.type === "not_authenticated";

  const StatusIcon = () => {
    if (!status) return <Terminal className="w-4 h-4 text-[var(--moba-text-muted)]" />;
    if (isReady) return <CheckCircle className="w-4 h-4 text-green-400" />;
    if (isNotAuth) return <AlertTriangle className="w-4 h-4 text-yellow-400" />;
    return <XCircle className="w-4 h-4 text-red-400" />;
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[13px] font-semibold">Claude Code Integration</div>
        <div className="text-[11px] text-[var(--moba-text-muted)]">
          Bring your own CLI · NewMob does not bundle the binary · No Anthropic credentials are stored
        </div>
      </div>

      {/* Enable toggle */}
      <div
        className={`flex items-center gap-3 rounded border p-3 cursor-pointer transition-colors ${
          cc.enabled
            ? "border-[var(--moba-accent)]/40 bg-[var(--moba-accent)]/5"
            : "border-[var(--moba-divider)] bg-[var(--moba-bg)]"
        }`}
        onClick={() => saveConfig({ ...config, cc_bridge: { ...cc, enabled: !cc.enabled } })}
      >
        <StatusIcon />
        <div className="flex-1">
          <div className="text-[13px] font-semibold">
            Claude Code Integration {cc.enabled ? "· Enabled" : ""}
          </div>
          <div className="text-[11px] text-[var(--moba-text-muted)]">
            {status?.message ?? "When enabled, Claude Code becomes a selectable provider in the Chat Drawer"}
          </div>
        </div>
        <div className={`w-9 h-5 rounded-full transition-colors relative ${cc.enabled ? "bg-[var(--moba-accent)]" : "bg-[var(--moba-divider)]"}`}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${cc.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </div>
      </div>

      {/* Detect button */}
      <button
        type="button"
        className="moba-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
        onClick={handleDetect}
        disabled={detecting}
      >
        {detecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Terminal className="w-3.5 h-3.5" />}
        Detect Claude Code
      </button>

      {/* Install instructions (shown when not found) */}
      {isNotFound && (
        <div className="rounded border border-[var(--moba-divider)] p-3 space-y-2">
          <div className="text-[12px] font-semibold">Install Claude Code CLI</div>
          {INSTALL_COMMANDS.map(({ platform, cmd }) => (
            <div key={platform}>
              <div className="text-[10px] text-[var(--moba-text-muted)] mb-0.5">{platform}</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-[11px] bg-[var(--moba-bg)] rounded px-2 py-1 truncate">
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
          Found v{status.status.found}, but v{status.status.required} or higher is required.
          Run <code className="font-mono">npm update -g @anthropic-ai/claude-code</code> to upgrade.
        </div>
      )}

      {/* Not authenticated */}
      {isNotAuth && (
        <div className="flex items-center gap-2 text-[11px] text-yellow-400 rounded border border-yellow-500/30 bg-yellow-500/5 px-2 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>Not authenticated. Run <code className="font-mono">claude login</code> in a terminal to sign in.</span>
        </div>
      )}

      {/* Ready — show config options */}
      {isReady && cc.enabled && (
        <div className="space-y-2 pt-2 border-t border-[var(--moba-divider)]">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-[var(--moba-text-muted)] block mb-1">Default model</label>
              <select
                className="moba-input h-7 w-full text-[12px]"
                value={cc.default_model}
                onChange={(e) => saveConfig({ ...config, cc_bridge: { ...cc, default_model: e.target.value } })}
              >
                <option value="sonnet">claude-sonnet (recommended)</option>
                <option value="opus">claude-opus (most capable)</option>
                <option value="haiku">claude-haiku (fastest)</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-[var(--moba-text-muted)] block mb-1">Max turns</label>
              <input
                type="number"
                className="moba-input h-7 w-full text-[12px]"
                min={1}
                max={50}
                value={cc.max_turns}
                onChange={(e) => saveConfig({ ...config, cc_bridge: { ...cc, max_turns: parseInt(e.target.value) || 20 } })}
              />
            </div>
          </div>
          <div className="text-[10px] text-[var(--moba-text-muted)]">
            ⚠ Claude Code is hidden automatically when full-local mode is on (CC must call Anthropic over the network)
          </div>
        </div>
      )}
    </div>
  );
}
