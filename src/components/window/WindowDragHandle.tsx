import { GripHorizontal } from "lucide-react";
import { useT } from "../../lib/i18n";
import { startWindowDrag } from "../../lib/windowDrag";

/**
 * A fixed, visible drag target for the borderless main window. Keeping this
 * separate from the tab strip means tab count cannot consume the window-move
 * affordance.
 */
export function WindowDragHandle() {
  const t = useT();
  const label = t("window.drag");

  return (
    <div
      data-testid="window-drag-handle"
      data-window-drag
      title={label}
      aria-label={label}
      className="taomni-window-drag-handle h-full shrink-0 inline-flex items-center justify-center"
      onMouseDown={startWindowDrag}
    >
      <GripHorizontal aria-hidden="true" className="w-4 h-4" />
    </div>
  );
}
