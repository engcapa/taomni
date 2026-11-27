import { useRef, useState, type ComponentProps } from "react";
import { useZoomTarget } from "../../hooks/useZoomTarget";

/** One mounted page owns its scale, so hiding another tab cannot reset it. */
export function PageZoomPanel({ active, children, style, ...props }: ComponentProps<"div"> & { active: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [percent, setPercent] = useState(100);
  useZoomTarget(root, active, (action) => {
    setPercent((previous) => action === "reset" ? 100
      : Math.min(200, Math.max(60, previous + (action === "in" ? 10 : -10))));
  }, true);
  return <div {...props} ref={root} style={{ ...style, zoom: percent === 100 ? undefined : percent / 100 }}>{children}</div>;
}
