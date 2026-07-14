import { useCallback, useEffect, useState } from "react";
import { Copy, RefreshCw, Server } from "lucide-react";
import { lspDetectServers, type LspServerStatus } from "../../lib/editor/lsp";
import { writeText } from "../../lib/clipboard";
import { useT } from "../../lib/i18n";
import {
  CUSTOM_LSP_COMMAND_ID,
  readLspCommandPrefs,
  readLspCustomCommands,
  writeLspCommandPrefs,
  writeLspCustomCommands,
  type LspCustomCommandConfig,
} from "../editor/workspace/codeWorkspaceModel";

/**
 * Global language-server configuration (install hints, binary selection,
 * custom commands). Lives in Settings so every Code Workspace does not
 * repeat the same panel in the project tree.
 */
export function LanguageServersSettings() {
  const t = useT();
  const [statuses, setStatuses] = useState<LspServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commandPrefs, setCommandPrefs] = useState<Record<string, string>>(() => readLspCommandPrefs());
  const [customCommands, setCustomCommands] = useState<Record<string, LspCustomCommandConfig>>(
    () => readLspCustomCommands(),
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await lspDetectServers();
      setStatuses(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateCommand = (presetId: string, commandId: string) => {
    setCommandPrefs((current) => {
      const next = { ...current, [presetId]: commandId };
      writeLspCommandPrefs(next);
      return next;
    });
  };

  const updateCustom = (presetId: string, patch: Partial<LspCustomCommandConfig>) => {
    setCustomCommands((current) => {
      const existing = current[presetId] ?? { command: "", args: "" };
      const nextConfig = { ...existing, ...patch };
      const next = { ...current };
      if (nextConfig.command.trim() || nextConfig.args.trim()) next[presetId] = nextConfig;
      else delete next[presetId];
      writeLspCustomCommands(next);
      return next;
    });
  };

  const missingCount = statuses.filter((status) => !status.available).length;

  return (
    <section
      data-testid="language-servers-settings"
      className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3"
    >
      <div className="mb-3 flex items-start gap-3">
        <Server className="mt-0.5 h-4 w-4 shrink-0 text-[var(--taomni-accent)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{t("settings.languageServersTitle")}</div>
          <div className="text-[12px] text-[var(--taomni-text-muted)]">
            {t("settings.languageServersSubtitle")}
          </div>
        </div>
        <button
          type="button"
          data-testid="language-servers-refresh"
          className="taomni-btn h-7 px-2.5 inline-flex items-center gap-1 text-[11px]"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("settings.languageServersRefresh")}
        </button>
      </div>

      {error && (
        <div className="mb-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[12px] text-red-500">
          {error}
        </div>
      )}

      <div className="mb-2 flex items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
        <span>
          {loading
            ? t("settings.languageServersDetecting")
            : t("settings.languageServersSummary", {
              available: statuses.filter((s) => s.available).length,
              total: statuses.length,
            })}
        </span>
        {missingCount > 0 && (
          <span className="text-amber-500">
            {t("settings.languageServersMissing", { count: missingCount })}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {statuses.map((status) => {
          const custom = customCommands[status.presetId] ?? { command: "", args: "" };
          const selected = commandPrefs[status.presetId]
            ?? status.selectedCommandId
            ?? status.commands[0]?.id
            ?? "";
          return (
            <div
              key={status.presetId}
              data-testid={`language-server-row-${status.presetId}`}
              className="rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] px-2.5 py-2"
            >
              <div className="flex items-center gap-2 text-[12px]">
                <span
                  data-available={status.available || undefined}
                  className="h-2 w-2 shrink-0 rounded-full bg-amber-500 data-[available=true]:bg-[var(--taomni-accent)]"
                  title={status.available ? "Available" : "Not found on PATH"}
                />
                <span className="min-w-0 flex-1 font-medium text-[var(--taomni-text)]">
                  {status.displayName}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--taomni-text-muted)]">
                  {status.documentLanguageIds.slice(0, 3).join(", ")}
                  {status.documentLanguageIds.length > 3 ? "…" : ""}
                </span>
              </div>

              <label className="mt-1.5 block text-[11px] text-[var(--taomni-text-muted)]">
                {t("settings.languageServersCommand")}
                <select
                  value={selected}
                  className="mt-0.5 h-7 w-full rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 text-[12px] text-[var(--taomni-text)] outline-none"
                  onChange={(event) => updateCommand(status.presetId, event.target.value)}
                  aria-label={`${status.displayName} language server command`}
                >
                  {status.commands.map((command) => (
                    <option key={command.id} value={command.id}>
                      {command.label}{command.fallback ? " fallback" : ""}
                      {command.available ? "" : " — missing"}
                    </option>
                  ))}
                  <option value={CUSTOM_LSP_COMMAND_ID}>
                    {t("settings.languageServersCustomCommand")}
                  </option>
                </select>
              </label>

              {selected === CUSTOM_LSP_COMMAND_ID && (
                <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  <input
                    value={custom.command}
                    className="h-7 min-w-0 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 font-mono text-[11px] text-[var(--taomni-text)] outline-none"
                    placeholder={t("settings.languageServersCommandPlaceholder")}
                    aria-label={`${status.displayName} custom command`}
                    onChange={(event) => updateCustom(status.presetId, { command: event.target.value })}
                  />
                  <input
                    value={custom.args}
                    className="h-7 min-w-0 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 font-mono text-[11px] text-[var(--taomni-text)] outline-none"
                    placeholder={t("settings.languageServersArgsPlaceholder")}
                    aria-label={`${status.displayName} custom args`}
                    onChange={(event) => updateCustom(status.presetId, { args: event.target.value })}
                  />
                </div>
              )}

              {!status.available && status.installHint && (
                <InstallHintRow hint={status.installHint} label={status.displayName} />
              )}
              {status.error && (
                <div className="mt-1 text-[11px] text-red-500">{status.error}</div>
              )}
            </div>
          );
        })}
        {!loading && statuses.length === 0 && (
          <div className="py-4 text-center text-[12px] text-[var(--taomni-text-muted)]">
            {t("settings.languageServersEmpty")}
          </div>
        )}
      </div>
    </section>
  );
}

function InstallHintRow({ hint, label }: { hint: string; label: string }) {
  const t = useT();
  return (
    <div className="mt-1.5 flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-600">
      <div
        className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono leading-snug text-[var(--taomni-text)]"
        title={hint}
        data-testid="language-servers-install-hint"
      >
        <span className="mr-1 font-sans font-medium text-amber-600">
          {t("settings.languageServersInstall")}:
        </span>
        {hint}
      </div>
      <button
        type="button"
        className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-amber-500/15"
        title={t("settings.languageServersCopyInstall")}
        aria-label={`${t("settings.languageServersCopyInstall")} (${label})`}
        data-testid="language-servers-copy-install-hint"
        onClick={() => { void writeText(hint); }}
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
