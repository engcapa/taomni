import { ChevronDown, ChevronUp, Trash } from "lucide-react";
import { useEffect } from "react";
import { useT } from "../../../lib/i18n";
import { type TunnelLogEntry } from "./model";

export function ActivityLog({
  logs,
  expanded,
  onToggle,
  onClear,
  listRef,
}: {
  logs: TunnelLogEntry[];
  expanded: boolean;
  onToggle: () => void;
  onClear: () => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const errorCount = logs.filter((l) => l.level === "error").length;
  const latest = logs.length > 0 ? logs[logs.length - 1] : null;

  // Auto-scroll to the newest entry whenever the panel is open and a new
  // log lands. Skipping this when collapsed keeps the toggle bar stable.
  useEffect(() => {
    if (!expanded) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, expanded, listRef]);

  return (
    <div
      data-testid="tunnel-activity-log"
      className="border-t shrink-0 flex flex-col"
      style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}
    >
      <button
        type="button"
        data-testid="tunnel-activity-log-toggle"
        className="h-7 px-3 flex items-center gap-2 text-[11px] hover:bg-[var(--taomni-hover)] text-left"
        onClick={onToggle}
        style={{ color: "var(--taomni-text)" }}
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
        <span className="font-semibold">{t("tunnels.logTitle")}</span>
        <span style={{ color: "var(--taomni-text-muted)" }}>
          {t("tunnels.logCount", { count: logs.length })}
        </span>
        {errorCount > 0 && (
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
            style={{ background: "rgba(178,34,34,0.15)", color: "#b22222" }}
          >
            {t("tunnels.logErrors", { count: errorCount })}
          </span>
        )}
        <div className="flex-1" />
        {!expanded && latest && (
          <span
            className="truncate max-w-[60%]"
            style={{
              color:
                latest.level === "error"
                  ? "#b22222"
                  : latest.level === "success"
                    ? "#1f7a4a"
                    : "var(--taomni-text-muted)",
            }}
            title={latest.text}
          >
            {latest.text}
          </span>
        )}
      </button>
      {expanded && (
        <div className="flex flex-col" style={{ maxHeight: 180 }}>
          <div className="flex items-center justify-end px-2 py-1 border-b" style={{ borderColor: "var(--taomni-divider)" }}>
            <button
              type="button"
              data-testid="tunnel-activity-log-clear"
              className="taomni-btn flex items-center gap-1 text-[11px]"
              onClick={onClear}
              disabled={logs.length === 0}
              title={t("tunnels.logClear")}
            >
              <Trash className="w-3 h-3" /> {t("tunnels.logClear")}
            </button>
          </div>
          <div
            ref={listRef}
            className="flex-1 overflow-auto px-3 py-1.5 taomni-mono text-[11px] leading-[1.6]"
            style={{ background: "var(--taomni-bg)" }}
          >
            {logs.length === 0 ? (
              <div className="text-center py-3" style={{ color: "var(--taomni-text-muted)" }}>
                {t("tunnels.logEmpty")}
              </div>
            ) : (
              logs.map((entry) => <ActivityLogRow key={entry.id} entry={entry} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ActivityLogRow({ entry }: { entry: TunnelLogEntry; }) {
  const color =
    entry.level === "error"
      ? "#b22222"
      : entry.level === "success"
        ? "#1f7a4a"
        : "var(--taomni-text)";
  return (
    <div className="flex items-start gap-2" style={{ color }}>
      <span style={{ color: "var(--taomni-text-muted)" }}>{formatLogTime(entry.ts)}</span>
      <span className="whitespace-pre-wrap break-words">{entry.text}</span>
    </div>
  );
}

export function formatLogTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
