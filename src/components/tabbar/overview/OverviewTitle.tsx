import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const MARQUEE_GAP_PX = 36;
const MARQUEE_SPEED_PX_PER_SEC = 40;
const MIN_MARQUEE_DURATION_SEC = 4.5;

export interface OverviewTitleState {
  overflowing: boolean;
  durationSec: number;
}

export function computeMarqueeDuration(contentWidth: number): number {
  return Math.max(
    MIN_MARQUEE_DURATION_SEC,
    Number(((contentWidth + MARQUEE_GAP_PX) / MARQUEE_SPEED_PX_PER_SEC).toFixed(2)),
  );
}

/**
 * Shows the full card title whenever it fits, and activates a seamless
 * marquee subtitle loop when horizontal overflow would truncate it.
 */
export function OverviewTitle({ title }: { title: string }) {
  const viewportRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<OverviewTitleState>({
    overflowing: false,
    durationSec: MIN_MARQUEE_DURATION_SEC,
  });
  const overflowingRef = useRef(false);

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const text = textRef.current;
    if (!viewport || !track || !text) return;

    const availableWidth = viewport.getBoundingClientRect().width || viewport.clientWidth;
    if (availableWidth <= 0) return;

    const textRectWidth = text.getBoundingClientRect().width;
    const contentWidth = overflowingRef.current
      ? Math.max(textRectWidth, text.scrollWidth)
      : Math.max(textRectWidth, track.scrollWidth);

    const overflowing = overflowingRef.current
      ? contentWidth > availableWidth + 0.5
      : (track.scrollWidth > track.clientWidth && track.clientWidth > 0)
        || contentWidth > availableWidth + 1;

    const durationSec = overflowing
      ? computeMarqueeDuration(contentWidth)
      : MIN_MARQUEE_DURATION_SEC;

    overflowingRef.current = overflowing;
    setState((prev) => (
      prev.overflowing === overflowing && prev.durationSec === durationSec
        ? prev
        : { overflowing, durationSec }
    ));
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    let frame: number | null = null;
    let pending = false;
    const observer = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(() => {
        pending = false;
        frame = null;
        measure();
      });
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [measure]);

  useLayoutEffect(() => {
    measure();
  }, [measure, title]);

  const trackStyle = state.overflowing
    ? ({ "--taomni-marquee-duration": `${state.durationSec}s` } as CSSProperties)
    : undefined;

  return (
    <strong
      ref={viewportRef}
      title={title}
      data-testid="tab-overview-card-title"
      data-overflowing={state.overflowing ? "true" : undefined}
      className="taomni-overview-title"
    >
      <span
        ref={trackRef}
        className="taomni-overview-title-track"
        data-marquee={state.overflowing ? title : undefined}
        style={trackStyle}
      >
        <span ref={textRef} className="taomni-overview-title-text">{title}</span>
      </span>
    </strong>
  );
}
