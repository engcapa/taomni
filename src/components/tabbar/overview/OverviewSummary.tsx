import { useLayoutEffect, useRef } from "react";

/** Wrapped terminal output follows the newest line; file previews stay at the start. */
export function OverviewSummary({ text, followLatest }: { text: string; followLatest: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) element.scrollTop = followLatest ? element.scrollHeight : 0;
  }, [text, followLatest]);
  return <pre ref={ref} data-testid="tab-overview-summary" className="taomni-overview-summary">{text}</pre>;
}
