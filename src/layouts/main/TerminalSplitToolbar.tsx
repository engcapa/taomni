import { type ReactNode } from "react";
import { Columns2, Grid2X2, Rows3, X } from "lucide-react";
import { type TerminalSplitLayout } from "../../stores/appStore";
import { useT } from "../../lib/i18n";


export function TerminalSplitToolbar({
  layout,
  lockedCount,
  onLayoutChange,
  onClearLocks,
  onClose,
}: {
  layout: TerminalSplitLayout;
  lockedCount: number;
  onLayoutChange: (layout: TerminalSplitLayout) => void;
  onClearLocks: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const options: Array<{ id: TerminalSplitLayout; label: string; icon: ReactNode }> = [
    { id: "horizontal", label: t("terminalSplit.horizontal"), icon: <Columns2 className="w-3.5 h-3.5" /> },
    { id: "vertical", label: t("terminalSplit.vertical"), icon: <Rows3 className="w-3.5 h-3.5" /> },
    { id: "grid", label: t("terminalSplit.grid"), icon: <Grid2X2 className="w-3.5 h-3.5" /> },
  ];

  return (
    <div
      data-testid="terminal-split-toolbar"
      className="h-8 shrink-0 flex items-center gap-1 px-2"
      style={{
        background: "var(--taomni-chrome-bg)",
        borderBottom: "1px solid var(--taomni-divider)",
      }}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          data-testid={`terminal-split-layout-${option.id}`}
          aria-label={option.label}
          title={option.label}
          data-active={layout === option.id || undefined}
          className="h-6 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
          style={layout === option.id ? { background: "var(--taomni-selected)", color: "var(--taomni-accent)" } : undefined}
          onClick={() => onLayoutChange(option.id)}
        >
          {option.icon}
        </button>
      ))}
      <span className="taomni-pill ml-1" style={{ fontSize: 11 }}>
        {t("terminalSplit.locked", { count: lockedCount })}
      </span>
      <button
        type="button"
        className="text-[11px] px-1.5 py-0.5 rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40"
        style={{ color: "var(--taomni-text-muted)" }}
        disabled={lockedCount === 0}
        onClick={onClearLocks}
      >
        {t("terminalSplit.clearLocks")}
      </button>
      <div className="flex-1" />
      <button
        type="button"
        aria-label={t("terminalSplit.closeView")}
        title={t("terminalSplit.closeView")}
        className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
        onClick={onClose}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
