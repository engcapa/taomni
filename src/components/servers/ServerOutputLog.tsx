import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Trash } from "lucide-react";
import type { ServerType } from "../../lib/servers";
import { useServersStore } from "../../stores/serversStore";
import { useT } from "../../lib/i18n";

interface Props {
  serverType: ServerType;
}

/**
 * Scrolling console for a server's stdout/stderr. Auto-scrolls to the newest
 * line while the auto-scroll toggle is on; the user can disable it to read
 * back through history without being yanked to the bottom.
 */
export function ServerOutputLog({ serverType }: Props) {
  const t = useT();
  const logLines = useServersStore((s) => s.runtimes[serverType]?.logLines ?? []);
  const clearLog = useServersStore((s) => s.clearLog);
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoScroll) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLines, autoScroll]);

  return (
    <div className="flex flex-col mt-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-semibold" style={{ color: "var(--taomni-text)" }}>
          {t("servers.output")}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          data-testid="server-log-autoscroll"
          className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded hover:bg-[var(--taomni-hover)]"
          aria-pressed={autoScroll}
          title={t("servers.autoScroll")}
          onClick={() => setAutoScroll((v) => !v)}
          style={{ color: autoScroll ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
        >
          <ArrowDownToLine className="w-3 h-3" />
          {t("servers.autoScroll")}
        </button>
        <button
          type="button"
          data-testid="server-log-clear"
          className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded hover:bg-[var(--taomni-hover)]"
          title={t("servers.clear")}
          disabled={logLines.length === 0}
          onClick={() => clearLog(serverType)}
          style={{ color: "var(--taomni-text-muted)" }}
        >
          <Trash className="w-3 h-3" />
          {t("servers.clear")}
        </button>
      </div>
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label={t("servers.output")}
        data-testid="server-log"
        className="overflow-auto rounded px-2 py-1.5 whitespace-pre-wrap break-words"
        style={{
          height: 120,
          background: "var(--taomni-term-bg)",
          color: "var(--taomni-term-text)",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: 11,
          lineHeight: 1.5,
          border: "1px solid var(--taomni-divider)",
        }}
      >
        {logLines.length === 0 ? (
          <div style={{ color: "var(--taomni-text-muted)", opacity: 0.7 }}>—</div>
        ) : (
          logLines.map((line, i) => <div key={i}>{line}</div>)
        )}
      </div>
    </div>
  );
}
