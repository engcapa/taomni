import { X } from "lucide-react";
import { HBASE_COMMANDS, commandSupported, type HBaseCommandCategory, type HBaseTransport } from "../../../lib/hbaseCommands";
import { useT } from "../../../lib/i18n";

// PLACEHOLDER_MENU
export const CATEGORY_ORDER: HBaseCommandCategory[] = ["meta", "read", "ddl", "dml"];

export const CATEGORY_LABEL: Record<HBaseCommandCategory, string> = {
  meta: "Meta",
  read: "Read",
  ddl: "DDL (tables)",
  dml: "DML (cells)",
};

export function CommandsMenu({
  transport,
  onPick,
  onClose,
}: {
  transport: HBaseTransport;
  onPick: (example: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="absolute left-2 top-9 z-50 w-[360px] max-w-[calc(100vw-24px)] max-h-[min(420px,calc(100vh-48px))] overflow-auto taomni-scroll-y rounded shadow-lg py-1 text-[12px]"
        style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)", color: "var(--taomni-text)" }}
      >
        {CATEGORY_ORDER.map((cat) => {
          const cmds = HBASE_COMMANDS.filter((c) => c.category === cat);
          if (cmds.length === 0) return null;
          return (
            <div key={cat}>
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--taomni-text-muted)]">{CATEGORY_LABEL[cat]}</div>
              {cmds.map((c) => {
                const supported = commandSupported(c.verb, transport);
                return (
                  <button
                    key={c.verb}
                    type="button"
                    disabled={!supported}
                    className="w-full text-left px-3 py-1.5 hover:bg-[var(--taomni-hover)] disabled:opacity-40 flex flex-col gap-0.5"
                    title={supported ? c.description : `${c.description} (not available on the ${transport} transport)`}
                    onClick={() => { onPick(c.example); onClose(); }}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="taomni-mono font-semibold">{c.verb}</span>
                      {c.isWrite && <span className="text-[9px] rounded px-1" style={{ background: "var(--taomni-divider)", color: c.destructive ? "#d9534f" : "var(--taomni-text-muted)" }}>{c.destructive ? "destructive" : "write"}</span>}
                      {!supported && <span className="text-[9px] text-[var(--taomni-text-muted)]">unsupported</span>}
                    </span>
                    <span className="taomni-mono text-[10px] text-[var(--taomni-text-muted)] truncate">{c.example}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

export function HistoryDropdown({ history, onPick, onClose }: { history: string[]; onPick: (cmd: string) => void; onClose: () => void; }) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-2 top-9 z-50 w-[420px] max-w-[calc(100vw-24px)] max-h-[min(300px,calc(100vh-48px))] overflow-auto rounded shadow-lg taomni-scroll-y flex flex-col" style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)" }}>
        {history.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-[var(--taomni-text-muted)]">No command history yet.</div>
        ) : (
          history.map((cmd, i) => (
            <button key={i} type="button" className="text-left px-3 py-2 text-[11px] truncate font-mono hover:bg-[var(--taomni-hover)] border-b border-[var(--taomni-divider)] last:border-0" onClick={() => onPick(cmd)} title={cmd}>
              {cmd.replace(/\s+/g, " ")}
            </button>
          ))
        )}
      </div>
    </>
  );
}

export function HelpDialog({ transport, onClose }: { transport: HBaseTransport; onClose: () => void; }) {
  const t = useT();
  return (
    <div className="fixed inset-0 z-[950] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <div
        role="dialog"
        aria-label={t("hbaseObjects.helpTitle")}
        aria-modal="true"
        data-testid="hbase-help-dialog"
        className="w-[640px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-auto taomni-scroll-y rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center mb-3">
          <div className="text-sm font-semibold flex-1">{t("hbaseObjects.helpTitle")}</div>
          <button type="button" className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={onClose} aria-label={t("hbaseObjects.helpClose")}>
            <X className="w-4 h-4" />
          </button>
        </div>
        {CATEGORY_ORDER.map((cat) => {
          const cmds = HBASE_COMMANDS.filter((c) => c.category === cat);
          return (
            <div key={cat} className="mb-3">
              <div className="text-[10px] uppercase tracking-wide text-[var(--taomni-text-muted)] mb-1">{CATEGORY_LABEL[cat]}</div>
              <table className="w-full text-[12px] border-collapse">
                <tbody>
                  {cmds.map((c) => {
                    const supported = commandSupported(c.verb, transport);
                    return (
                      <tr key={c.verb} className="border-b" style={{ borderColor: "var(--taomni-divider)", opacity: supported ? 1 : 0.55 }}>
                        <td className="py-1 pr-2 align-top taomni-mono font-semibold whitespace-nowrap">{c.verb}</td>
                        <td className="py-1 pr-2 align-top taomni-mono text-[11px] text-[var(--taomni-text-muted)]">{c.syntax}</td>
                        <td className="py-1 align-top text-[11px]">
                          {c.description}
                          {!supported && <div className="text-[10px]" style={{ color: "#d9534f" }}>{t("hbaseObjects.helpRestNote")}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}
