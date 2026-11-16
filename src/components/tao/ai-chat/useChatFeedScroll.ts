import { useCallback, useLayoutEffect, useRef } from "react";
import type { TaoMessage, TaoPhase } from "./ports";

/** Follow new replies while pinned; leave a reader's earlier position alone. */
export function useChatFeedScroll(threadId: string | null, messages: TaoMessage[] | undefined, phase: TaoPhase, active: boolean) {
  const feedRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previousThread = useRef(threadId);
  const frame = useRef<number | undefined>(undefined);

  const schedule = useCallback(() => {
    if (!active || !pinned.current) return;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const feed = feedRef.current;
      if (feed && pinned.current) feed.scrollTop = feed.scrollHeight;
    });
  }, [active]);

  useLayoutEffect(() => {
    if (!active) return;
    let disposed = false;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => { if (!disposed) schedule(); });
    if (feedRef.current) observer?.observe(feedRef.current);
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => {
      disposed = true;
      observer?.disconnect();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
  }, [threadId, active, schedule]);

  useLayoutEffect(() => {
    if (previousThread.current !== threadId) {
      pinned.current = true;
      previousThread.current = threadId;
    }
    schedule();
  }, [threadId, messages, phase, schedule]);

  const onScroll = () => {
    const feed = feedRef.current;
    if (feed) pinned.current = feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 32;
  };
  return { feedRef, contentRef, onScroll };
}
