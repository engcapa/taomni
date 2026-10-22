import type { CSSProperties } from "react";
import { AnnotationCanvas } from "./AnnotationCanvas";
import { ScreenshotOverlayView } from "./overlay/ScreenshotOverlayView";
import { createScreenshotToolbar } from "./overlay/ScreenshotToolbar";
import { type Handle } from "./overlay/types";
import { useScreenshotActions } from "./overlay/useScreenshotActions";
import { useScreenshotOverlayState } from "./overlay/useScreenshotOverlayState";
import { useScreenshotSelection } from "./overlay/useScreenshotSelection";

export type { WatermarkSettings } from "../../lib/screenshotImage";

export function ScreenshotOverlay() {
  const state = useScreenshotOverlayState();
  const selection = useScreenshotSelection({
    state,
    get handleCopy() { return actions.handleCopy; },
  });
  const actions = useScreenshotActions({
    state,
    selection,
  });

  if (state.loadError) {
    return (
      <div
        data-testid="screenshot-overlay"
        className="fixed inset-0 flex items-center justify-center"
        style={{ background: "#141414", color: "#ffffff" }}
      >
        <div className="text-center px-6 max-w-xl">
          <p data-testid="screenshot-overlay-error" className="mb-4 text-[14px] break-words">
            {state.t("screenshot.openFailed", { error: state.loadError })}
          </p>
          <button
            type="button"
            data-testid="screenshot-cancel"
            onClick={state.close}
            className="rounded-lg px-4 py-1.5 text-[13px]"
            style={{ background: "var(--taomni-accent)", color: "#ffffff" }}
          >
            {state.t("screenshot.cancel")}
          </button>
        </div>
      </div>
    );
  }

  const showHandles = state.phase === "annotate" && state.sel && state.tool === "select" && !state.pickerMode;
  const handles: { h: Handle; x: number; y: number; }[] = state.sel
    ? [
      { h: "nw", x: state.sel.x, y: state.sel.y },
      { h: "n", x: state.sel.x + state.sel.w / 2, y: state.sel.y },
      { h: "ne", x: state.sel.x + state.sel.w, y: state.sel.y },
      { h: "e", x: state.sel.x + state.sel.w, y: state.sel.y + state.sel.h / 2 },
      { h: "se", x: state.sel.x + state.sel.w, y: state.sel.y + state.sel.h },
      { h: "s", x: state.sel.x + state.sel.w / 2, y: state.sel.y + state.sel.h },
      { h: "sw", x: state.sel.x, y: state.sel.y + state.sel.h },
      { h: "w", x: state.sel.x, y: state.sel.y + state.sel.h / 2 },
    ]
    : [];
  const physSel = state.sel ? state.toPhysical(state.sel) : null;
  const panelStyle: CSSProperties = {
    background: "var(--taomni-panel-bg)",
    border: "1px solid var(--taomni-divider)",
    color: "var(--taomni-text)",
  };

  const annotationLayer = state.img && (
    <AnnotationCanvas
      ref={state.canvasRef}
      imageWidth={state.imageSize.w}
      imageHeight={state.imageSize.h}
      tool={(state.phase === "annotate" || state.phase === "preview") && !state.pickerMode ? state.tool : "select"}
      color={state.color}
      lineWidth={state.lineWidth}
      fontFamily={state.fontFamily}
      fontSize={state.fontSize}
      fill={state.fill}
      eraserMode={state.eraserMode}
      onDrawingChange={state.setDrawing}
      textHint={state.t("screenshot.textHint")}
      baseImage={state.img}
      selection={state.sel}
      selectionContour={state.contour}
      onHistoryChange={(u, r) => {
        state.setCanUndo(u);
        state.setCanRedo(r);
      }}
      onSelectionChange={state.onAnnotationSelection}
      onRequestReselect={(p) => {
        selection.resetSelection();
        selection.startRegionDrag(p.x, p.y);
      }}
    />
  );
  const { toolbar } = createScreenshotToolbar({
    state,
    panelStyle,
    selection,
    actions,
  });

  return <ScreenshotOverlayView
    state={state}
    selection={selection}
    showHandles={showHandles}
    handles={handles}
    annotationLayer={annotationLayer}
    physSel={physSel}
    toolbar={toolbar}
    panelStyle={panelStyle}
    actions={actions}
  />;
}
