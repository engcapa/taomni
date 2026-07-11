import type { ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export interface BottomDockTab {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  content: ReactNode;
}

interface BottomDockProps {
  open: boolean;
  activeTab: string;
  tabs: BottomDockTab[];
  onOpenChange: (open: boolean) => void;
  onActiveTabChange: (tabId: string) => void;
}

export function BottomDock({
  open,
  activeTab,
  tabs,
  onOpenChange,
  onActiveTabChange,
}: BottomDockProps) {
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

  const selectTab = (tabId: string) => {
    if (open && tabId === active?.id) {
      onOpenChange(false);
      return;
    }
    onActiveTabChange(tabId);
    onOpenChange(true);
  };

  return (
    <section
      data-testid="code-workspace-bottom-dock"
      data-open={open || undefined}
      className="shrink-0 border-t border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]"
    >
      <div className="h-8 flex items-center gap-0.5 overflow-x-auto px-1">
        {tabs.map((tab) => {
          const selected = tab.id === active?.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected && open}
              data-active={(selected && open) || undefined}
              className="h-7 shrink-0 inline-flex items-center gap-1.5 rounded px-2 text-[11px] font-medium text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
              onClick={() => selectTab(tab.id)}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {typeof tab.badge === "number" && tab.badge > 0 && (
                <span className="min-w-4 rounded bg-[var(--taomni-code-active-line-bg)] px-1 text-center text-[10px] tabular-nums text-[var(--taomni-code-text)]">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
        <div className="flex-1" />
        {active && (
          <button
            type="button"
            title={open ? "Collapse bottom panel" : "Expand bottom panel"}
            aria-label={open ? "Collapse bottom panel" : "Expand bottom panel"}
            className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={() => onOpenChange(!open)}
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      {open && active && (
        <div role="tabpanel" aria-label={active.label} className="h-48 min-h-0 overflow-hidden border-t border-[var(--taomni-code-border)]">
          {active.content}
        </div>
      )}
    </section>
  );
}
