import { useCallback, useLayoutEffect, useRef } from "react";
import type { TaoMessage, TaoPhase } from "./ports";

/** Follow new replies while pinned; leave a reader's earlier position alone. */
export function useChatFeedScroll(threadId: string | null, messages: TaoMessage[] | undefined, phase: TaoPhase, active: boolean) {
  const feedRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastScrollTop = useRef(0);
  const previousThread = useRef(threadId);
  const lastUserId = messages?.filter((message) => message.role === "user").at(-1)?.id;
  const previousUser = useRef(lastUserId);
  const frame = useRef<number | undefined>(undefined);

  const schedule = useCallback(() => {
    if (!active || !pinned.current) return;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const feed = feedRef.current;
      if (feed && pinned.current) {
        feed.scrollTop = feed.scrollHeight;
        lastScrollTop.current = feed.scrollTop;
      }
    });
  }, [active]);

  useLayoutEffect(() => {
    if (!active) return;
    let disposed = false;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => { if (!disposed) schedule(); });
    // Markdown commits and asynchronous enhancements can replace their DOM
    // after React's frame, before the WebView reports its resized content box.
    const mutations = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(() => { if (!disposed) schedule(); });
    if (feedRef.current) observer?.observe(feedRef.current);
    if (contentRef.current) {
      observer?.observe(contentRef.current);
      mutations?.observe(contentRef.current, { childList: true, characterData: true, subtree: true });
    }
    return () => {
      disposed = true;
      observer?.disconnect();
      mutations?.disconnect();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
  }, [threadId, active, schedule]);

  useLayoutEffect(() => {
    if (previousThread.current !== threadId || (lastUserId && previousUser.current !== lastUserId)) {
      pinned.current = true;
      lastScrollTop.current = feedRef.current?.scrollTop ?? 0;
    }
    previousThread.current = threadId;
    previousUser.current = lastUserId;
    schedule();
  }, [threadId, lastUserId, messages, phase, schedule]);

  const onScroll = () => {
    const feed = feedRef.current;
    if (!feed) return;
    const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
    if (maximum - feed.scrollTop <= 32) pinned.current = true;
    // A queued programmatic scroll can arrive after the next streamed layout.
    // A larger gap alone is not evidence that the reader scrolled backwards.
    else if (feed.scrollTop < Math.min(lastScrollTop.current, maximum) - 1) pinned.current = false;
    lastScrollTop.current = feed.scrollTop;
    if (pinned.current && maximum - feed.scrollTop > 0) schedule();
  };
  return { feedRef, contentRef, onScroll };
}
