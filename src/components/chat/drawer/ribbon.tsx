import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Bot, Mail, StickyNote } from "lucide-react";
import { useChatStore, isChatCapableTabType, type ChatDrawerPosition } from "../../../stores/chatStore";
import { useAppStore } from "../../../stores/appStore";
import { useT } from "../../../lib/i18n";
import { placementFromPoint, ribbonPositionStyle } from "../../../lib/tao/ribbonPlacement";
import { useTaoHubStore } from "../../../stores/taoHubStore";
import { useNotesStore } from "../../../stores/notesStore";
import { useTaoAlertStore } from "../../../stores/taoAlertStore";
import { alertColorBucket, buildTaoAlerts, topAlertKind } from "../../../lib/tao/taoAlerts";

export const SIDE_RIBBON_HOVER_OPEN_DELAY_MS = 260;

export const TOP_BOTTOM_RIBBON_HOVER_OPEN_DELAY_MS = 650;

export function ChatDrawerRibbon() {
  const t = useT();
  const drawerOpen = useChatStore((s) => s.drawerOpen);
  const drawerPosition = useChatStore((s) => s.drawerPosition);
  const drawerPinned = useChatStore((s) => s.drawerPinned);
  const ribbonOffsetRatio = useChatStore((s) => s.ribbonOffsetRatio);
  const openTabChat = useChatStore((s) => s.openTabChat);
  const setRibbonPlacement = useChatStore((s) => s.setRibbonPlacement);
  const setHubTab = useTaoHubStore((s) => s.setHubTab);
  const noteAlerts = useNotesStore((s) => s.alerts);
  const aiDoneAlerts = useTaoAlertStore((s) => s.aiDone);
  const mailNewAlerts = useTaoAlertStore((s) => s.mailNew);
  const recordAlertHistory = useTaoAlertStore((s) => s.recordHistory);
  const pruneMailTabs = useTaoAlertStore((s) => s.pruneMailTabs);
  const bumpRef = useRef(0);
  const [bumping, setBumping] = useState(false);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const dragRef = useRef<{ x: number; y: number; dragging: boolean; } | null>(null);
  const suppressClickRef = useRef(false);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; } | null>(null);
  const [signalIndex, setSignalIndex] = useState(0);

  useEffect(() => {
    return () => {
      if (hoverOpenTimerRef.current !== null) {
        window.clearTimeout(hoverOpenTimerRef.current);
      }
    };
  }, []);

  // Unified Tao alerts (notes due/overdue/reminder + chat ai_done + mail), priority-sorted.
  const taoAlerts = useMemo(
    () => buildTaoAlerts(noteAlerts, aiDoneAlerts, mailNewAlerts),
    [noteAlerts, aiDoneAlerts, mailNewAlerts],
  );
  const alertBadgeCount = useMemo(
    () => taoAlerts.reduce((sum, alert) => sum + (alert.count ?? 1), 0),
    [taoAlerts],
  );
  useEffect(() => {
    recordAlertHistory(taoAlerts);
  }, [recordAlertHistory, taoAlerts]);
  const ribbonSignals = useMemo(() => {
    const next: Array<"mail" | "notes" | "chat"> = [];
    for (const alert of taoAlerts) {
      const source = alert.source === "mail" ? "mail" : alert.source === "notes" ? "notes" : "chat";
      if (!next.includes(source)) next.push(source);
    }
    return next;
  }, [taoAlerts]);
  const ribbonSignalKey = ribbonSignals.join("|");
  useEffect(() => {
    pruneMailTabs(tabs.map((tab) => tab.id));
  }, [pruneMailTabs, tabs]);
  useEffect(() => {
    setSignalIndex(0);
    if (ribbonSignals.length <= 1) return;
    const id = window.setInterval(() => {
      setSignalIndex((current) => (current + 1) % ribbonSignals.length);
    }, 1400);
    return () => window.clearInterval(id);
  }, [ribbonSignalKey, ribbonSignals.length]);
  const activeSignal = ribbonSignals.length > 0
    ? ribbonSignals[signalIndex % ribbonSignals.length]
    : null;
  const RibbonSignalIcon = activeSignal === "mail"
    ? Mail
    : activeSignal === "notes"
      ? StickyNote
      : Bot;
  const hasAlerts = taoAlerts.length > 0;
  const hostTab = activeTab && isChatCapableTabType(activeTab.type)
    ? activeTab
    : tabs.find((tab) => isChatCapableTabType(tab.type)) ?? activeTab;
  const chatTabId = hostTab?.chatTabId ?? hostTab?.id ?? null;
  const hostTitle = hostTab?.title ?? activeTab?.title ?? "Taomni";
  const ribbonTitle = hasAlerts ? t("tao.alertInboxTitle") : t("chat.ribbonOpenTitle", { title: hostTitle });
  const ribbonAria = ribbonTitle;
  const badgeText = alertBadgeCount > 99 ? "99+" : String(alertBadgeCount);

  useEffect(
    () => {
      if (alertBadgeCount > bumpRef.current) {
        setBumping(true);
        const id = window.setTimeout(() => setBumping(false), 1200);
        bumpRef.current = alertBadgeCount;
        return () => window.clearTimeout(id);
      }
      bumpRef.current = alertBadgeCount;
    },
    [alertBadgeCount],
  );

  if (drawerOpen || !activeTab || !chatTabId || (!hasAlerts && !isChatCapableTabType(activeTab.type))) return null;

  const placementClass = ribbonPlacementClass(drawerPosition, hasAlerts);
  const textClass = ribbonTextClass(drawerPosition);
  const dragging = dragPreview !== null;
  const ribbonClass = dragging
    ? "fixed h-10 w-10 rounded-full border"
    : `absolute ${placementClass} border`;
  const ribbonStyle: CSSProperties = {
    background: "var(--taomni-tao-ribbon-bg)",
    borderColor: "var(--taomni-tao-ribbon-border)",
    boxShadow: "var(--taomni-tao-ribbon-shadow)",
    color: "var(--taomni-tao-ribbon-text)",
    touchAction: "none",
    ...(dragPreview
      ? {
        left: dragPreview.x,
        top: dragPreview.y,
        transform: "translate(-50%, -50%)",
      }
      : ribbonPositionStyle({ edge: drawerPosition, offsetRatio: ribbonOffsetRatio })),
  };

  // Alert glow: recolor the ribbon by highest-severity pending alert.
  const topKind = topAlertKind(taoAlerts);
  const colorBucket = alertColorBucket(topKind);
  const alertColor =
    colorBucket === "red"
      ? "#ef4444"
      : colorBucket === "amber"
        ? "#f59e0b"
        : colorBucket === "accent"
          ? "var(--taomni-accent)"
          : null;
  if (alertColor && !dragPreview) {
    ribbonStyle.borderColor = alertColor;
    ribbonStyle.boxShadow = `0 0 0 2px ${alertColor}66`;
  }
  const badgeBg =
    colorBucket === "red"
      ? "bg-red-500 text-white"
      : colorBucket === "amber"
        ? "bg-amber-400 text-black"
        : "bg-[var(--taomni-accent)] text-white";

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    if (hoverOpenTimerRef.current !== null) {
      window.clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    dragRef.current = { x: event.clientX, y: event.clientY, dragging: false };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Browser preview fallback.
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6) {
      drag.dragging = true;
      setDragPreview({ x: event.clientX, y: event.clientY });
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragPreview(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Browser preview fallback.
    }
    if (!drag?.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = true;
    const placement = placementFromPoint(
      event.clientX,
      event.clientY,
      window.innerWidth || 1,
      window.innerHeight || 1,
    );
    setRibbonPlacement(placement.edge, placement.offsetRatio);
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    dragRef.current = null;
    setDragPreview(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Browser preview fallback.
    }
  };

  const scheduleHoverOpen = () => {
    if (drawerPinned || hoverOpenTimerRef.current !== null || dragRef.current) return;
    const delay = drawerPosition === "top" || drawerPosition === "bottom"
      ? TOP_BOTTOM_RIBBON_HOVER_OPEN_DELAY_MS
      : SIDE_RIBBON_HOVER_OPEN_DELAY_MS;
    hoverOpenTimerRef.current = window.setTimeout(() => {
      hoverOpenTimerRef.current = null;
      if (!dragRef.current) {
        if (hasAlerts) setHubTab("notifications");
        void openTabChat(chatTabId);
      }
    }, delay);
  };

  const clearHoverOpen = () => {
    if (hoverOpenTimerRef.current === null) return;
    window.clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
  };

  return (
    <>
      <button
        type="button"
        data-testid="ai-chat-drawer-ribbon"
        data-position={drawerPosition}
        data-dragging={dragging || undefined}
        data-alert-count={alertBadgeCount || undefined}
        className={`${ribbonClass} z-40 flex items-center justify-center text-[9px] font-semibold tracking-normal shadow-lg transition-transform duration-150 hover:scale-105 cursor-grab active:cursor-grabbing ${bumping ? "animate-bounce" : ""}`}
        style={ribbonStyle}
        title={ribbonTitle}
        aria-label={ribbonAria}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onMouseEnter={scheduleHoverOpen}
        onMouseLeave={clearHoverOpen}
        onClick={(event) => {
          if (suppressClickRef.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (hasAlerts) {
            setHubTab("notifications");
            void openTabChat(chatTabId);
            return;
          }
          void openTabChat(chatTabId);
        }}
      >
        {hasAlerts ? (
          <RibbonSignalIcon className="w-4 h-4" data-testid="tao-ribbon-alert-icon" />
        ) : (
          <span className={textClass}>Tao</span>
        )}
        {hasAlerts && (
          <span
            className={`absolute -top-1 -right-1 min-w-[13px] h-[13px] px-1 rounded-full text-[8px] font-bold flex items-center justify-center ${badgeBg}`}
            data-testid="tao-ribbon-badge"
          >
            {badgeText}
          </span>
        )}
      </button>
    </>
  );
}

export function ribbonPlacementClass(position: ChatDrawerPosition, alertMode = false): string {
  // Shape only (size / rounding / open border side); the position along the
  // edge is applied via inline style from ribbonPositionStyle().
  switch (position) {
    case "left":
      return alertMode ? "h-12 w-7 rounded-r-full border-l-0" : "h-10 w-5 rounded-r-full border-l-0";
    case "right":
      return alertMode ? "h-12 w-7 rounded-l-full border-r-0" : "h-10 w-5 rounded-l-full border-r-0";
    case "top":
      return alertMode ? "h-7 w-12 rounded-b-full border-t-0" : "h-5 w-10 rounded-b-full border-t-0";
    case "bottom":
      return alertMode ? "h-7 w-12 rounded-t-full border-b-0" : "h-5 w-10 rounded-t-full border-b-0";
  }
}

export function ribbonTextClass(position: ChatDrawerPosition): string {
  switch (position) {
    case "left":
      return "-rotate-90 leading-none";
    case "right":
      return "rotate-90 leading-none";
    case "top":
    case "bottom":
      return "leading-none";
  }
}
