import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Tab } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { buildTabDetailSummary } from "../../lib/tabDetails";
import { useT } from "../../lib/i18n";

const CARD_WIDTH = 250;
const CARD_HEIGHT = 116;
const CARD_GAP = 8;
const VIEWPORT_MARGIN = 8;

interface Placement {
  tab: Tab;
  left: number;
  top: number;
  anchorLeft: number;
}

interface TabDetailsOverlayProps {
  open: boolean;
  tabs: readonly Tab[];
  tabElements: ReadonlyMap<string, HTMLElement>;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** When set, render only the hovered tab instead of every visible tab. */
  tabId?: string | null;
}

function stateColor(state: ReturnType<typeof buildTabDetailSummary>["activityState"]): string {
  switch (state) {
    case "running":
      return "#22c55e";
    case "idle":
      return "#60a5fa";
    case "connecting":
      return "#f59e0b";
    case "disconnected":
      return "#ef4444";
    default:
      return "var(--taomni-text-muted)";
  }
}

export function TabDetailsOverlay({
  open,
  tabs,
  tabElements,
  scrollRef,
  tabId = null,
}: TabDetailsOverlayProps) {
  const t = useT();
  const sessions = useSessionStore((s) => s.sessions);
  const runtimeByTab = useAppStore((s) => s.terminalRuntimeByTab);
  const cwdByTab = useAppStore((s) => s.cwdByTab);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const [placements, setPlacements] = useState<Placement[]>([]);

  const measure = useCallback(() => {
    if (!open) {
      setPlacements([]);
      return;
    }
    const scroll = scrollRef.current;
    if (!scroll) return;
    const clip = scroll.getBoundingClientRect();
    const candidates = tabs
      .filter((tab) => !tabId || tab.id === tabId)
      .map((tab) => ({ tab, rect: tabElements.get(tab.id)?.getBoundingClientRect() }))
      .filter((item): item is { tab: Tab; rect: DOMRect } => !!item.rect)
      .filter(({ rect }) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > clip.left + 1 &&
        rect.left < clip.right - 1 &&
        rect.right > 0 &&
        rect.left < window.innerWidth,
      )
      .sort((a, b) => a.rect.left - b.rect.left);

    const laneRight: number[] = [];
    const next: Placement[] = [];
    for (const { tab, rect } of candidates) {
      const anchor = Math.max(clip.left, Math.min(rect.left + rect.width / 2, clip.right));
      const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(anchor - CARD_WIDTH / 2, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN),
      );
      let lane = laneRight.findIndex((right) => left >= right + CARD_GAP);
      if (lane === -1) lane = laneRight.length;
      laneRight[lane] = left + CARD_WIDTH;
      next.push({
        tab,
        left,
        top: clip.bottom + 5 + lane * (CARD_HEIGHT + CARD_GAP),
        anchorLeft: Math.max(12, Math.min(anchor - left, CARD_WIDTH - 12)),
      });
    }
    setPlacements(next);
  }, [open, scrollRef, tabElements, tabId, tabs]);

  useLayoutEffect(() => {
    measure();
    if (!open) return;
    const scroll = scrollRef.current;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (scroll) observer?.observe(scroll);
    window.addEventListener("resize", measure);
    scroll?.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      scroll?.removeEventListener("scroll", measure);
    };
  }, [measure, open, scrollRef]);

  if (!open || placements.length === 0) return null;

  return createPortal(
    <div data-testid="tab-details-overlay" className="fixed inset-0 pointer-events-none z-[9990]" aria-hidden="true">
      {placements.map(({ tab, left, top, anchorLeft }) => {
        const summary = buildTabDetailSummary(tab, sessions, runtimeByTab[tab.id], cwdByTab[tab.id], t);
        const active = activeTabId === tab.id;
        return (
          <div
            key={tab.id}
            data-testid={`tab-details-card-${tab.id}`}
            className="fixed rounded-md border shadow-xl px-3 py-2 text-[11px] overflow-visible"
            style={{
              left,
              top,
              width: CARD_WIDTH,
              minHeight: CARD_HEIGHT,
              background: "var(--taomni-panel-bg)",
              borderColor: active ? "var(--taomni-accent)" : "var(--taomni-divider)",
              color: "var(--taomni-text)",
            }}
          >
            <span
              className="absolute -top-1.5 h-3 w-3 rotate-45 border-l border-t"
              style={{
                left: anchorLeft - 6,
                background: "var(--taomni-panel-bg)",
                borderColor: active ? "var(--taomni-accent)" : "var(--taomni-divider)",
              }}
            />
            <div className="relative flex items-center gap-2 font-medium">
              <span className="min-w-0 flex-1 truncate" title={tab.title}>{tab.title}</span>
              {summary.activityState && (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: stateColor(summary.activityState) }} />
              )}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1">
              <span className="shrink-0 text-[var(--taomni-text-muted)]">{summary.connectionLabel}</span>
              <span className="text-[var(--taomni-text-muted)]">·</span>
              <span className="min-w-0 truncate" title={summary.sessionLabel}>{summary.sessionLabel}</span>
            </div>
            {summary.endpoint && (
              <div className="truncate text-[10px] text-[var(--taomni-text-muted)]" title={summary.endpoint}>
                {summary.endpoint}
              </div>
            )}
            {tab.type === "terminal" && (
              <div
                className="mt-1 truncate text-[12px] font-semibold"
                title={summary.cwd ?? undefined}
              >
                {summary.cwd ?? t("tabs.detailsCwdUnknown")}
              </div>
            )}
            {summary.program ? (
              <div className="flex min-w-0 items-center gap-1" title={summary.activityLabel}>
                <span className="shrink-0 text-[var(--taomni-text-muted)]">{t("tabs.detailsRunning")}</span>
                <span className="text-[var(--taomni-text-muted)]">·</span>
                <span
                  data-testid={`tab-details-program-${tab.id}`}
                  className="min-w-0 truncate font-semibold"
                  style={{ color: "var(--taomni-accent-soft)" }}
                >
                  {summary.program}
                </span>
              </div>
            ) : (
              <div className="truncate text-[var(--taomni-text-muted)]" title={summary.activityLabel}>
                {summary.activityLabel}
              </div>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
