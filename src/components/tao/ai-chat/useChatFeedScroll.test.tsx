import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatFeedScroll } from "./useChatFeedScroll";
import type { TaoMessage } from "./ports";

function Harness({ thread = "first", value = "reply", active = true, user = "question" }: { thread?: string; value?: string; active?: boolean; user?: string }) {
  const messages: TaoMessage[] = [
    { id: user, role: "user", text: user, blocks: [], createdAt: 0 },
    { id: "reply", role: "assistant", text: value, blocks: [], createdAt: 0 },
  ];
  const scroll = useChatFeedScroll(thread, messages, "streaming", active);
  return <div data-testid="feed" ref={scroll.feedRef} onScroll={scroll.onScroll}><div ref={scroll.contentRef}>{value}</div></div>;
}

describe("chat feed following", () => {
  const frames = new Map<number, FrameRequestCallback>();
  const observers: { notify: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
  let next = 0;
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); };
  const dimensions = (feed: HTMLElement) => {
    let height = 1000;
    let top = 0;
    Object.defineProperties(feed, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(height - 400, value)); } },
    });
    return (value: number) => { height = value; };
  };
  beforeEach(() => {
    frames.clear(); observers.length = 0; next = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("ResizeObserver", class {
      disconnect = vi.fn();
      constructor(notify: () => void) { observers.push({ notify, disconnect: this.disconnect }); }
      observe() {}
    });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("follows streamed content and later renderer/width changes while pinned", () => {
    const view = render(<Harness />);
    const feed = screen.getByTestId("feed");
    const grow = dimensions(feed);
    flush();
    expect(feed.scrollTop).toBe(600);
    grow(1400);
    view.rerender(<Harness value="more reply text" />);
    flush();
    expect(feed.scrollTop).toBe(1000);
    grow(1600);
    observers[0].notify();
    flush();
    expect(feed.scrollTop).toBe(1200);
  });

  it("leaves a reader's earlier position alone until they return to the bottom", () => {
    const view = render(<Harness />);
    const feed = screen.getByTestId("feed");
    const grow = dimensions(feed);
    flush();
    feed.scrollTop = 80;
    fireEvent.scroll(feed);
    grow(1400);
    view.rerender(<Harness value="new reply" />);
    observers[0].notify();
    flush();
    expect(feed.scrollTop).toBe(80);
    feed.scrollTop = 1000;
    fireEvent.scroll(feed);
    grow(1800);
    observers[0].notify();
    flush();
    expect(feed.scrollTop).toBe(1400);
  });

  it("follows a newly sent question after reading earlier replies, including delayed diagram rendering", () => {
    const view = render(<Harness />);
    const feed = screen.getByTestId("feed");
    const grow = dimensions(feed);
    flush();
    feed.scrollTop = 80;
    fireEvent.scroll(feed);
    grow(1400);
    view.rerender(<Harness user="new question" value="new reply" />);
    flush();
    expect(feed.scrollTop).toBe(1000);
    grow(1800);
    observers[0].notify();
    flush();
    expect(feed.scrollTop).toBe(1400);

    feed.scrollTop = 120;
    fireEvent.scroll(feed);
    grow(2000);
    view.rerender(<Harness user="new question" value="streamed continuation" />);
    observers[0].notify();
    flush();
    expect(feed.scrollTop).toBe(120);
  });

  it("reveals another history thread and stops stale work when inactive or unmounted", () => {
    const view = render(<Harness />);
    const feed = screen.getByTestId("feed");
    dimensions(feed);
    flush();
    feed.scrollTop = 20;
    fireEvent.scroll(feed);
    view.rerender(<Harness thread="history" />);
    flush();
    expect(feed.scrollTop).toBe(600);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    view.rerender(<Harness thread="history" active={false} />);
    observers.at(-1)!.notify();
    expect(frames.size).toBe(0);
    view.rerender(<Harness thread="history" />);
    expect(frames.size).toBe(1);
    view.unmount();
    observers.at(-1)!.notify();
    expect(frames.size).toBe(0);
  });
});
