import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { ToolActivityEntry } from "./toolActivity";
import { allToolsSettled } from "./toolActivity";

export interface ToolActivityBlockProps {
  tools: ToolActivityEntry[];
  /**
   * When true, the block starts expanded. Live streaming cards can pass this
   * while tools are still in flight if desired; the default (and product
   * preference) is collapsed.
   */
  defaultExpanded?: boolean;
  className?: string;
}

/**
 * Collapsible transcript of agent tool calls. Collapsed by default so long
 * ACP / Claude Code runs (dozens of `search_tool` / `run_terminal_command`
 * steps) don't dominate the chat scroll area; click the header to expand.
 */
export function ToolActivityBlock({
  tools,
  defaultExpanded = false,
  className = "",
}: ToolActivityBlockProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (tools.length === 0) return null;

  const settled = allToolsSettled(tools);
  const pending = tools.filter((tool) => tool.result === undefined).length;
  const countLabel = settled
    ? t("chat.toolActivitySummaryDone", { count: tools.length })
    : pending === tools.length
      ? t("chat.toolActivitySummaryRunning", { count: tools.length })
      : t("chat.toolActivitySummaryMixed", {
          done: tools.length - pending,
          total: tools.length,
        });
  // Collapsed header still shows the most useful arg previews so the user
  // can scan what the agent did without expanding a long run.
  const preview = tools
    .slice(0, 3)
    .map((tool) => {
      const detail = tool.detail?.trim();
      return detail ? `${tool.tool}: ${detail}` : tool.tool;
    })
    .join(" · ");
  const more = tools.length > 3 ? ` · +${tools.length - 3}` : "";
  const summary = preview ? `${countLabel} — ${preview}${more}` : countLabel;

  return (
    <div
      className={`my-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]/40 ${className}`}
      data-testid="chat-tool-activity"
    >
      <button
        type="button"
        className="w-full flex items-center gap-1.5 px-2 py-1 text-left text-[11px] text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)]/40 rounded"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={summary}
        data-testid="chat-tool-activity-toggle"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 shrink-0 text-[var(--taomni-accent)]" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0 text-[var(--taomni-accent)]" />
        )}
        {settled ? (
          <Wrench className="w-3 h-3 shrink-0 text-[var(--taomni-accent)]" />
        ) : (
          <Loader2 className="w-3 h-3 shrink-0 text-[var(--taomni-accent)] animate-spin" />
        )}
        <span className="truncate">{summary}</span>
      </button>
      {expanded && (
        <div
          className="border-t border-[var(--taomni-divider)] px-2 py-1 flex flex-col gap-0.5"
          data-testid="chat-tool-activity-list"
        >
          {tools.map((tool, i) => (
            <ToolActivityRow key={`${tool.tool}-${i}`} entry={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolActivityRow({ entry }: { entry: ToolActivityEntry }) {
  const pending = entry.result === undefined;
  const result = entry.result?.trim() ?? "";
  // Status-only strings are low signal once the tool name is visible.
  const showResult =
    result !== ""
    && !/^(completed|failed|ok|success|done)$/i.test(result);
  return (
    <div
      className="rounded border border-[var(--taomni-divider)]/60 bg-[var(--taomni-bg)] px-1.5 py-0.5 text-[10px] font-mono"
      data-testid="chat-tool-activity-row"
    >
      <div className="flex items-start gap-1 min-w-0">
        <span className="text-[var(--taomni-accent)] shrink-0">🔧</span>
        <span className="font-semibold text-[var(--taomni-text)] shrink-0">{entry.tool}</span>
        {entry.detail && (
          <span className="min-w-0 break-all text-[var(--taomni-text-muted)]" title={entry.detail}>
            {entry.detail}
          </span>
        )}
        {pending && (
          <Loader2 className="w-2.5 h-2.5 ml-auto shrink-0 animate-spin text-[var(--taomni-accent)]" />
        )}
      </div>
      {showResult && (
        <div
          className="mt-0.5 max-h-16 overflow-auto whitespace-pre-wrap break-all text-[var(--taomni-text-muted)]"
          title={result}
        >
          ↳ {result}
        </div>
      )}
    </div>
  );
}
