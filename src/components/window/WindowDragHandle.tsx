import { useT } from "../../lib/i18n";
import { startWindowDrag } from "../../lib/windowDrag";

/**
 * A fixed, visible drag target for the borderless main window. Keeping this
 * at the left edge for the entire window height means neither tab count nor
 * tool window buttons can consume the window-move affordance.
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
      className="taomni-window-drag-handle"
      onMouseDown={startWindowDrag}
    />
  );
}
