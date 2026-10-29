import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { WorkspaceIsolatedTab } from "../../stores/workspacePlatformStore";
import { useElementResizeFrame } from "../../hooks/useElementResizeFrame";
import { maxScrollLeft, setTabScrollLeft, TAB_SCROLL_EDGE_TOLERANCE, TAB_SCROLL_PADDING, TAB_SCROLL_STEP_MIN } from "../tabbar/tabs/scroll";

/** Owns overflow observation and active-tab visibility for one workspace strip. */
export function useWorkspaceTabScroll(workspaceId: string | undefined, tabs: readonly WorkspaceIsolatedTab[] | undefined, activeTabId: string | null | undefined) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabElements = useRef(new Map<string, HTMLDivElement>());
  const userScrolled = useRef(false);
  const [scrollState, setScrollState] = useState({ overflow: false, atStart: true, atEnd: true });
  const setTabElement = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) tabElements.current.set(id, element);
    else tabElements.current.delete(id);
  }, []);

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current;
    if (!element || element.clientWidth <= 0) return;
    const maxLeft = maxScrollLeft(element);
    const next = {
      overflow: maxLeft > TAB_SCROLL_EDGE_TOLERANCE,
      atStart: element.scrollLeft <= TAB_SCROLL_EDGE_TOLERANCE,
      atEnd: element.scrollLeft >= maxLeft - TAB_SCROLL_EDGE_TOLERANCE,
    };
    setScrollState((previous) => (
      previous.overflow === next.overflow && previous.atStart === next.atStart && previous.atEnd === next.atEnd
        ? previous
        : next
    ));
  }, []);

  const revealActiveTab = useCallback(() => {
    const element = scrollRef.current;
    const active = activeTabId ? tabElements.current.get(activeTabId) : null;
    if (!element || element.clientWidth <= 0) return;
    if (active && !userScrolled.current) {
      const viewport = element.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      const left = rect.left - viewport.left + element.scrollLeft;
      const right = rect.right - viewport.left + element.scrollLeft;
      if (rect.width > element.clientWidth || left < element.scrollLeft + TAB_SCROLL_PADDING) {
        setTabScrollLeft(element, left - TAB_SCROLL_PADDING);
      } else if (right > element.scrollLeft + element.clientWidth - TAB_SCROLL_PADDING) {
        setTabScrollLeft(element, right - element.clientWidth + TAB_SCROLL_PADDING);
      }
    }
    updateScrollState();
  }, [activeTabId, updateScrollState]);

  const scheduleMeasurement = useElementResizeFrame(scrollRef, revealActiveTab);
  useLayoutEffect(() => {
    userScrolled.current = false;
  }, [workspaceId, activeTabId]);
  useLayoutEffect(() => {
    scheduleMeasurement();
  }, [workspaceId, tabs, revealActiveTab, scheduleMeasurement]);

  const scrollBy = useCallback((direction: "left" | "right") => {
    const element = scrollRef.current;
    if (!element) return;
    userScrolled.current = true;
    const delta = Math.max(TAB_SCROLL_STEP_MIN, Math.floor(element.clientWidth * 0.8));
    setTabScrollLeft(element, element.scrollLeft + (direction === "right" ? delta : -delta));
    updateScrollState();
  }, [updateScrollState]);

  const markUserScroll = useCallback(() => { userScrolled.current = true; }, []);

  return { scrollRef, scrollState, setTabElement, updateScrollState, scrollBy, markUserScroll, tabElements };
}
