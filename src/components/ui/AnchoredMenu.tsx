import type { ComponentProps, RefObject } from "react";
import { createPortal } from "react-dom";
import { ContextMenu } from "../ContextMenu";

type AnchoredMenuProps = Omit<ComponentProps<typeof ContextMenu>, "x" | "y" | "anchorRef"> & {
  anchor: RefObject<HTMLElement | null>;
  side?: "below" | "right";
};

export function AnchoredMenu({ anchor, side = "below", ...props }: AnchoredMenuProps) {
  const trigger = anchor.current;
  if (!trigger) return null;
  const bounds = trigger.getBoundingClientRect();
  return createPortal(
    <ContextMenu {...props} anchorRef={anchor} closeOnTab dismissOnFocusOut
      x={side === "right" ? bounds.right + 4 : bounds.left}
      y={side === "right" ? bounds.top : bounds.bottom + 4} />,
    trigger.closest("dialog[open]") ?? trigger.ownerDocument.body,
  );
}
