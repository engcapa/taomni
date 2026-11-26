import { Lasso, Maximize, Square, X } from "lucide-react";
import type { CSSProperties } from "react";
import { contourPath } from "../../../lib/screenshotSelection";
import { Modal } from "../../ui/Modal";
import { ImageEditPanel } from "../ImageEditPanel";
import { ScrollCaptureResult } from "../ScrollCaptureResult";
import { HANDLE, HANDLE_CURSORS } from "./geometry";
import { Magnifier } from "./Magnifier";
import { ScreenshotBaseImage } from "./ScreenshotBaseImage";
import { ToolButton } from "./ToolButton";
import { type Handle } from "./types";
import { useScreenshotActions } from "./useScreenshotActions";
import { useScreenshotOverlayState } from "./useScreenshotOverlayState";
import { useScreenshotSelection } from "./useScreenshotSelection";


export interface ScreenshotOverlayViewProps {
  state: ReturnType<typeof useScreenshotOverlayState>;
  selection: ReturnType<typeof useScreenshotSelection>;
  showHandles: boolean | null;
  handles: { h: Handle; x: number; y: number; }[];
  annotationLayer: import("react").JSX.Element | null;
  physSel: import("../../../lib/screenshot").PhysicalRect | null;
  toolbar: false | import("react").JSX.Element | null;
  panelStyle: CSSProperties;
  actions: ReturnType<typeof useScreenshotActions>;
}

export function ScreenshotOverlayView(props: ScreenshotOverlayViewProps) {
  const { state, selection, showHandles, handles, annotationLayer, physSel, toolbar, panelStyle, actions } = props;
  const { sel } = state;
  const opener = (id: string) => state.rootRef.current?.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const cancelPinDone = () => { if (!state.busyRef.current) state.setPinDoneOpen(false); };
  const cancelScroll = () => state.setScrollConfirm(false);
  return ((
    <div
      ref={state.rootRef}
      tabIndex={-1}
      data-testid="screenshot-overlay"
      data-phase={state.phase}
      data-selection-mode={state.selectionMode}
      className="fixed inset-0 isolate overflow-hidden select-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--taomni-focus-ring)]"
      // P0-1b: transparent until the base image exists, so an early frame of
      // the (transparent) overlay window shows the dimmed real desktop, not
      // a solid black or theme-coloured screen.
      style={{ background: state.img ? "var(--taomni-capture-image-bg)" : "transparent" }}
    >
      {!state.scrollResult && state.img && state.imgUrl && (
        <ScreenshotBaseImage image={state.img} width={state.imageSize.w} height={state.imageSize.h} />
      )}

      {/* Dim layer: full dim while selecting, selection-hole dim once selected. */}
      {!sel && (
        <div className="fixed inset-0 z-[var(--taomni-z-capture-dim)] pointer-events-none" style={{ background: "var(--taomni-capture-initial-dim)" }} />
      )}
      {state.contour && (
        <svg className="fixed inset-0 z-[var(--taomni-z-capture-selection)] pointer-events-none" width={state.viewport.w} height={state.viewport.h}>
          <path
            d={`M 0 0 H ${state.viewport.w} V ${state.viewport.h} H 0 Z ${contourPath(state.contour)}`}
            fill="var(--taomni-capture-dim)" fillRule="evenodd"
          />
          <path data-testid="screenshot-freehand-contour" d={contourPath(state.contour)} fill="none" stroke="var(--taomni-capture-selection-border)" strokeWidth={1} />
        </svg>
      )}
      {sel && state.phase !== "preview" && (
        <div
          data-testid="screenshot-selection"
          className="fixed z-[var(--taomni-z-capture-selection)] pointer-events-none"
          style={{
            left: sel.x,
            top: sel.y,
            width: Math.max(0, sel.w),
            height: Math.max(0, sel.h),
            outline: state.contour ? undefined : "1px solid var(--taomni-capture-selection-border)",
            border: state.contour ? "1px dashed var(--taomni-capture-selection-dashed)" : undefined,
            boxShadow: state.contour ? undefined : "0 0 0 9999px var(--taomni-capture-dim)",
          }}
        />
      )}

      {/* Region selection / outside-press layer. */}
      {!state.scrollResult && <div
        data-testid="screenshot-select-layer"
        className="fixed inset-0 z-[var(--taomni-z-capture-input)]"
        style={{ cursor: state.phase === "select" ? "crosshair" : "default" }}
        onMouseDown={selection.handleSelectMouseDown}
        onDoubleClick={selection.handleDoubleClick}
      />}

      {/* Move area + resize handles (no draw tool active). */}
      {showHandles && sel && (
        <>
          <div
            data-testid="screenshot-selection-move"
            className="fixed z-[var(--taomni-z-capture-move)]"
            style={{
              left: sel.x, top: sel.y, width: sel.w, height: sel.h, cursor: "move",
              clipPath: state.contour ? `polygon(evenodd, ${state.contour.map((p) => `${p.x - sel.x}px ${p.y - sel.y}px`).join(", ")})` : undefined,
            }}
            onMouseDown={(e) => selection.startHandleDrag(e, "move")}
            onDoubleClick={selection.handleDoubleClick}
          />
          {handles.map(({ h, x, y }) => (
            <div
              key={h}
              data-testid={`screenshot-handle-${h}`}
              className="fixed z-[var(--taomni-z-capture-handle)] rounded-sm"
              style={{
                left: x - HANDLE / 2,
                top: y - HANDLE / 2,
                width: HANDLE,
                height: HANDLE,
                background: "var(--taomni-capture-selection-border)",
                border: "1px solid var(--taomni-capture-handle-outline)",
                cursor: HANDLE_CURSORS[h],
              }}
              onMouseDown={(e) => selection.startHandleDrag(e, h)}
            />
          ))}
        </>
      )}

      {!state.scrollResult && annotationLayer}

      {/* Magnifier while choosing a region. */}
      {state.phase === "select" && state.img && state.cursor && (
        <Magnifier img={state.img} cursor={state.cursor} sx={state.sx} sy={state.sy} viewport={state.viewport} />
      )}

      {/* Size label at the selection's top-left. */}
      {sel && physSel && sel.w > 0 && sel.h > 0 && (state.phase === "select" || state.phase === "annotate") && (
        <div
          data-testid="screenshot-size-hint" className="text-ui-small"
          style={{
            position: "fixed",
            zIndex: "var(--taomni-z-capture-indicator)",
            left: sel.x,
            top: sel.y >= 26 ? sel.y - 24 : sel.y + 4,
            pointerEvents: "none",
            background: "var(--taomni-panel-bg)",
            color: "var(--taomni-text)",
            padding: "2px 6px",
            borderRadius: 4,
            whiteSpace: "nowrap",
          }}
        >
          {`${physSel.width} × ${physSel.height}`}
        </div>
      )}

      {!state.scrollResult && toolbar}

      {state.phase === "select" && state.displays.length > 1 && <label data-testid="screenshot-display-picker" className="fixed top-4 left-4 z-[var(--taomni-z-capture-toolbar)] rounded-lg p-2 text-ui-body" style={panelStyle}>
        {state.t("screenshot.selectDisplay")}
        <select data-testid="screenshot-display-select" aria-label={state.t("screenshot.selectDisplay")} disabled={state.busy} value={state.init?.displayId ?? ""} onChange={(e) => void actions.changeDisplay(e.target.value)} className="ml-2 rounded p-1 bg-[var(--taomni-panel-bg)]">
          {state.displays.map((display, i) => <option key={display.id} value={display.id}>{i + 1}. {display.name} · {display.width} × {display.height}</option>)}
        </select>
      </label>}

      {state.pinDoneOpen && <Modal title={state.t("screenshot.pinDoneTitle")} testId="screenshot-pin-done-dialog"
        initialFocus='[data-testid="screenshot-pin-done-cancel"]' returnFocus={opener("screenshot-scroll-result-copy")}
        onCancel={cancelPinDone} footer={<>
          <button className="taomni-btn" type="button" data-testid="screenshot-pin-done-cancel" disabled={state.busy} onClick={cancelPinDone}>{state.t("screenshot.cancel")}</button>
          <button className="taomni-btn" type="button" data-testid="screenshot-pin-done-copy" disabled={state.busy} onClick={() => void actions.finishPinEdit("copy")}>{state.t("screenshot.copyOnly")}</button>
          <button className="taomni-btn" type="button" data-testid="screenshot-pin-done-new" disabled={state.busy} onClick={() => void actions.finishPinEdit("new")}>{state.t("screenshot.pinNew")}</button>
          <button className="taomni-btn" data-danger="true" type="button" data-testid="screenshot-pin-done-replace" disabled={state.busy} onClick={() => void actions.finishPinEdit("replace")}>{state.t("screenshot.pinReplace")}</button>
        </>}>
        <p>{state.t("screenshot.pinDoneHint")}</p>
        {state.busy && <p role="status" className="mt-2">{state.t("screenshot.finishingPin")}</p>}
      </Modal>}

      {state.phase === "preview" && state.scrollResult && state.img && state.imgUrl && <ScrollCaptureResult url={state.imgUrl} width={state.img.naturalWidth} height={state.img.naturalHeight}
        frames={state.scrollResult.frames} toolbar={toolbar} onCopy={() => void actions.handleCopy()} onSave={() => void actions.handleSave()}
        onPin={() => void actions.handlePin()} onClose={state.close}>{annotationLayer}</ScrollCaptureResult>}

      {/* Busy state (scroll capture / recording start). */}
      {state.scrollConfirm && <Modal title={state.t("screenshot.scrollCapture")} testId="screenshot-scroll-confirm"
        initialFocus='[name="scroll-mode"]:checked' returnFocus={opener("screenshot-scroll-capture")}
        onCancel={cancelScroll} footer={<>
          <button data-testid="screenshot-scroll-confirm-cancel" type="button" className="taomni-btn" onClick={cancelScroll}>{state.t("screenshot.cancel")}</button>
          <button data-testid="screenshot-scroll-start" disabled={state.planningScroll || !state.plannedRegion} type="button" className="taomni-btn" data-primary="true" onClick={() => void actions.handleScrollCapture()}>{state.t("screenshot.scrollStart")}</button>
        </>}>
        <fieldset className="flex gap-4 mb-3">
          <legend className="sr-only">{state.t("screenshot.scrollMode")}</legend>
          {(["auto", "manual"] as const).map((mode) => <label key={mode} className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="scroll-mode" data-testid={`screenshot-scroll-mode-${mode}`} checked={state.scrollMode === mode} onChange={() => state.setScrollMode(mode)} />
            {state.t(mode === "auto" ? "screenshot.scrollAuto" : "screenshot.scrollManual")}
          </label>)}
        </fieldset>
        <p data-testid="screenshot-scroll-mode-description" className="mb-3">{state.t(state.scrollMode === "auto" ? "screenshot.scrollRunningHint" : "screenshot.scrollManualHint")}</p>
        {state.plannedRegion && physSel && state.plannedRegion.height !== physSel.height && <p data-testid="screenshot-scroll-adjusted" className="mb-3 text-ui-warning">{state.t("screenshot.scrollAdjusted", { width: state.plannedRegion.width, height: state.plannedRegion.height })}</p>}
        <p data-testid="screenshot-scroll-instructions" className="mb-4">{state.t("screenshot.scrollInstructions")}</p>
        {state.planningScroll && <p role="status">{state.t("screenshot.preparingScroll")}</p>}
      </Modal>}
      {state.phase === "busy" && (
        <div
          data-testid="screenshot-scroll-busy"
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl px-5 py-3 text-ui-body shadow-2xl"
          style={{ zIndex: "var(--taomni-z-capture-indicator)", ...panelStyle }}
        >
          {state.t("screenshot.scrollCapturing")}
        </div>
      )}

      {/* Bottom hint bar while selecting. */}
      {state.phase === "select" && !state.dragging && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-8 flex items-center gap-3 rounded-full px-4 py-2 shadow-2xl text-ui-body"
          style={{ zIndex: "var(--taomni-z-capture-toolbar)", ...panelStyle }}
        >
          <span data-testid="screenshot-hint">{state.t(state.selectionMode === "freehand" ? "screenshot.freehandHint" : "screenshot.selectHint")}</span>
          <ToolButton testid="screenshot-selection-rectangle" title={state.t("screenshot.selectionRectangle")} active={state.selectionMode === "rectangle"} onClick={() => selection.changeSelectionMode("rectangle")}>
            <Square size={16} />
          </ToolButton>
          <ToolButton testid="screenshot-selection-freehand" title={state.t("screenshot.selectionFreehand")} active={state.selectionMode === "freehand"} onClick={() => selection.changeSelectionMode("freehand")}>
            <Lasso size={16} />
          </ToolButton>
          <button
            type="button"
            data-testid="screenshot-fullscreen"
            onClick={selection.fullscreenSelect}
            className="taomni-btn flex items-center gap-1" data-primary="true"
          >
            <Maximize size={13} />
            {state.t("screenshot.fullscreen")}
          </button>
        </div>
      )}

      {state.editOpen && state.img && <ImageEditPanel key={`${state.img.naturalWidth}x${state.img.naturalHeight}:${state.imageUndo.length}:${state.imageRedo.length}`}
        width={physSel?.width ?? state.img.naturalWidth} height={physSel?.height ?? state.img.naturalHeight} busy={state.editBusy}
        returnFocus={opener("screenshot-edit")} canUndo={state.imageUndo.length > 0} canRedo={state.imageRedo.length > 0} onApply={(edit) => void actions.editImage(edit)}
        onUndo={actions.undoImage} onRedo={actions.redoImage} onExternal={(choose) => void actions.externalEdit(choose)} onClose={() => state.setEditOpen(false)} />}

      {/* Color picker layer (above the canvas, below the toolbar). */}
      {state.pickerMode && (
        <div
          data-testid="screenshot-picker-layer"
          className="fixed inset-0"
          style={{ zIndex: state.scrollResult ? "var(--taomni-z-capture-preview-pick)" : "var(--taomni-z-capture-pick)", cursor: "crosshair" }}
          onMouseMove={selection.handlePickerMove}
          onMouseLeave={() => state.setPickerInfo(null)}
          onClick={() => void selection.handlePickerPick()}
        />
      )}
      {state.pickerMode && state.pickerInfo && (
        <div
          data-testid="screenshot-picker-popup"
          className="fixed pointer-events-none flex items-center gap-2 rounded-lg px-2.5 py-1.5 shadow-2xl text-ui-body"
          style={{
            zIndex: state.scrollResult ? "var(--taomni-z-capture-preview-sample)" : "var(--taomni-z-capture-sample)",
            left: Math.min(state.pickerInfo.x + 18, state.viewport.w - 200),
            top: Math.min(state.pickerInfo.y + 18, state.viewport.h - 60),
            ...panelStyle,
          }}
        >
          <span className="w-6 h-6 rounded shrink-0" style={{ background: state.pickerInfo.hex, border: "1px solid var(--taomni-input-border)" }} />
          <span data-testid="screenshot-picker-hex" className="font-mono whitespace-nowrap">
            {state.pickerInfo.hex}
          </span>
          <span className="opacity-70 font-mono whitespace-nowrap">{state.pickerInfo.rgb}</span>
        </div>
      )}

      {/* OCR result panel. */}
      {state.ocrOpen && (
        <div
          data-testid="screenshot-ocr-panel"
          className="fixed rounded-xl shadow-2xl p-4 w-80"
          style={{ zIndex: "var(--taomni-z-popover)", right: 16, top: 16, ...panelStyle }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-ui-body font-medium">{state.t("screenshot.ocrTitle")}</span>
            <button
              type="button"
              data-testid="screenshot-ocr-close"
              aria-label={state.t("screenshot.cancel")}
              onClick={() => state.setOcrOpen(false)}
              className="rounded p-1 hover:bg-[var(--taomni-hover)]"
            >
              <X size={14} />
            </button>
          </div>
          {state.ocrLoading ? (
            <div className="text-ui-body opacity-70 py-4 text-center">{state.t("screenshot.ocrLoading")}</div>
          ) : (
            <>
              <textarea
                data-testid="screenshot-ocr-text"
                readOnly
                value={state.ocrText}
                rows={8}
                aria-label={state.t("screenshot.ocrTitle")}
                className="taomni-input w-full px-2 py-1.5 text-ui-body font-mono resize-y mb-2"
              />
              <button
                type="button"
                data-testid="screenshot-ocr-copy"
                onClick={() => {
                  import("../../../lib/clipboard")
                    .then(({ writeText }) => writeText(state.ocrText))
                    .then(() => state.showToast(state.t("screenshot.ocrCopied")))
                    .catch(() => state.showToast(state.t("screenshot.ocrCopyFailed")));
                }}
                className="taomni-btn w-full" data-primary="true"
              >
                {state.t("screenshot.ocrCopy")}
              </button>
            </>
          )}
        </div>
      )}

      {state.scrollError && (
        <div
          data-testid="screenshot-scroll-error"
          role="alert"
          className="fixed left-1/2 -translate-x-1/2 bottom-20 w-[min(640px,90vw)] rounded-lg px-4 py-3 text-ui-body shadow-2xl"
          style={{ zIndex: "var(--taomni-z-capture-result)", ...panelStyle }}
        >
          <p className="break-words">{state.t("screenshot.scrollFailed", { error: state.scrollError })}</p>
          <button type="button" data-testid="screenshot-scroll-error-close" className="mt-2 rounded px-3 py-2" onClick={state.close}>
            {state.t("screenshot.cancel")} (Esc)
          </button>
        </div>
      )}

      {/* Toast. */}
      {state.toast && (
        <div
          data-testid="screenshot-toast"
          role="status"
          className="fixed left-1/2 -translate-x-1/2 bottom-20 rounded-full px-4 py-2 text-ui-body shadow-2xl"
          style={{ zIndex: "var(--taomni-z-toast)", ...panelStyle }}
        >
          {state.toast}
        </div>
      )}
    </div>
  ));
}
