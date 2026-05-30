import { Play, Square, Settings2 } from "lucide-react";
import type { ServerDef, ServerRunState } from "../../lib/servers";
import { useT } from "../../lib/i18n";

interface Props {
  def: ServerDef;
  status: ServerRunState;
  selected: boolean;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
  onSettings: () => void;
}

const DOT_COLORS: Record<ServerRunState, string> = {
  running: "#16a34a",
  stopped: "#94a3b8",
  starting: "#f59e0b",
  error: "#dc2626",
};

/**
 * A single 40px-high row in the server list: status dot, name, and the
 * Play / Stop / Settings action buttons. The running dot pulses so an
 * active server reads at a glance even on a dense list.
 */
export function ServerRow({
  def,
  status,
  selected,
  onSelect,
  onStart,
  onStop,
  onSettings,
}: Props) {
  const t = useT();
  const name = t(def.labelKey);
  const running = status === "running";
  const busy = running || status === "starting";

  return (
    <div
      role="option"
      aria-selected={selected}
      data-testid={`server-row-${def.type}`}
      className="flex items-center gap-2 h-10 px-2 cursor-pointer select-none"
      style={{
        background: selected ? "var(--moba-selected)" : "transparent",
        borderLeft: selected
          ? "3px solid var(--moba-accent)"
          : "3px solid transparent",
        color: "var(--moba-text)",
      }}
      onClick={onSelect}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--moba-hover)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      <span
        aria-hidden="true"
        className={running ? "animate-pulse" : undefined}
        style={{
          width: 8,
          height: 8,
          borderRadius: "9999px",
          background: DOT_COLORS[status],
          flexShrink: 0,
        }}
      />
      <span className="flex-1 min-w-0 truncate text-[12px]" title={name}>
        {name}
      </span>
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          data-testid={`server-row-${def.type}-start`}
          className="flex items-center justify-center rounded hover:bg-[var(--moba-hover)] disabled:opacity-30 disabled:cursor-default"
          style={{ width: 22, height: 22 }}
          title={t("servers.start")}
          aria-label={`${t("servers.start")} ${name}`}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onStart();
          }}
        >
          <Play className="w-3.5 h-3.5" style={{ color: busy ? "var(--moba-text-muted)" : "#16a34a" }} />
        </button>
        <button
          type="button"
          data-testid={`server-row-${def.type}-stop`}
          className="flex items-center justify-center rounded hover:bg-[var(--moba-hover)] disabled:opacity-30 disabled:cursor-default"
          style={{ width: 22, height: 22 }}
          title={t("servers.stop")}
          aria-label={`${t("servers.stop")} ${name}`}
          disabled={!busy}
          onClick={(e) => {
            e.stopPropagation();
            onStop();
          }}
        >
          <Square className="w-3.5 h-3.5" style={{ color: busy ? "#dc2626" : "var(--moba-text-muted)" }} />
        </button>
        <button
          type="button"
          data-testid={`server-row-${def.type}-settings`}
          className="flex items-center justify-center rounded hover:bg-[var(--moba-hover)]"
          style={{ width: 22, height: 22 }}
          title={t("servers.settings")}
          aria-label={`${t("servers.settings")} ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onSettings();
          }}
        >
          <Settings2 className="w-3.5 h-3.5" style={{ color: "var(--moba-accent)" }} />
        </button>
      </div>
    </div>
  );
}
