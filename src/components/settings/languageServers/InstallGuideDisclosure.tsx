import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { writeText } from "../../../lib/clipboard";
import { useT } from "../../../lib/i18n";
import { osLabel, type LspInstallOs, type ResolvedInstallGuide } from "../../../lib/lspInstallGuides";

export function InstallGuideDisclosure({
  open,
  onToggle,
  guide,
  hostOs,
  label,
  available,
}: {
  open: boolean;
  onToggle: () => void;
  guide: ResolvedInstallGuide;
  hostOs: LspInstallOs | null;
  label: string;
  available: boolean;
}) {
  const t = useT();
  return (
    <div className="mt-1.5" data-testid="language-servers-install-disclosure">
      <button
        type="button"
        data-testid="language-servers-install-toggle"
        className="inline-flex h-6 items-center gap-1 rounded px-1 text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] hover:text-[var(--taomni-text)]"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5" />
          : <ChevronRight className="h-3.5 w-3.5" />}
        {open
          ? t("settings.languageServersHideInstall")
          : available
            ? t("settings.languageServersShowInstallInstalled")
            : t("settings.languageServersShowInstall")}
      </button>
      {open && (
        <div
          className="mt-1 flex flex-col gap-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-2"
          data-testid="language-servers-install-panel"
        >
          {guide.lines.map((line) => {
            const isCurrent = line.os != null && line.os === hostOs;
            const rowKey = line.os ?? "shared";
            return (
              <div
                key={rowKey}
                data-testid={`language-servers-install-line-${rowKey}`}
                data-current-os={isCurrent || undefined}
                className={`rounded px-1.5 py-1 ${isCurrent ? "bg-[var(--taomni-selected)]/40 ring-1 ring-[var(--taomni-accent-soft)]" : ""
                  }`}
              >
                <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium text-[var(--taomni-text-muted)]">
                  {line.os
                    ? (
                      <>
                        <span>{osLabel(line.os)}</span>
                        {isCurrent && (
                          <span className="rounded bg-[var(--taomni-accent)]/15 px-1 text-[var(--taomni-accent)]">
                            {t("settings.languageServersThisOs")}
                          </span>
                        )}
                      </>
                    )
                    : (
                      <span>{t("settings.languageServersAllOs")}</span>
                    )}
                  <button
                    type="button"
                    className="ml-auto inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] hover:text-[var(--taomni-text)]"
                    title={t("settings.languageServersCopyInstall")}
                    aria-label={`${t("settings.languageServersCopyInstall")} (${label}${line.os ? ` · ${osLabel(line.os)}` : ""})`}
                    data-testid={`language-servers-copy-install-${rowKey}`}
                    onClick={() => { void writeText(line.command); }}
                  >
                    <Copy className="h-3 w-3" />
                    {t("settings.languageServersCopy")}
                  </button>
                </div>
                {line.note && (
                  <div
                    className="mb-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-[var(--taomni-text)]"
                    data-testid={`language-servers-install-note-${rowKey}`}
                  >
                    <span className="font-semibold text-amber-600">
                      {t("settings.languageServersInstallNote")}:{" "}
                    </span>
                    {line.note}
                  </div>
                )}
                <div className="mb-0.5 text-[10px] text-[var(--taomni-text-muted)]">
                  {t("settings.languageServersCopyHint")}
                </div>
                <pre
                  className="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] px-2 py-1.5 font-mono text-[11px] leading-snug text-[var(--taomni-text)]"
                  data-testid={
                    // Keep a stable selector for the first/primary copyable command block.
                    line === guide.lines[0]
                      ? "language-servers-install-hint"
                      : `language-servers-install-cmd-${rowKey}`
                  }
                >
                  {line.command}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
