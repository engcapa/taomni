import {
  Check,
  ChevronDown,
  Crop,
  Download,
  Lasso,
  MoreHorizontal,
  Pin,
  Pipette,
  Redo2,
  ScanText,
  ScrollText,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  Stamp,
  Trash2,
  Undo2,
  Video,
  X,
} from "lucide-react";
import type { CSSProperties } from "react";
import { FILLABLE_TOOLS, FONT_STACK, type EraserMode } from "../AnnotationCanvas";
import { ToolButton } from "./ToolButton";
import { COLORS, LINE_WIDTHS, TOOLS } from "./tools";
import { useScreenshotActions } from "./useScreenshotActions";
import { useScreenshotOverlayState } from "./useScreenshotOverlayState";
import { useScreenshotSelection } from "./useScreenshotSelection";


export interface CreateScreenshotToolbarContext {
  state: ReturnType<typeof useScreenshotOverlayState>;
  panelStyle: CSSProperties;
  selection: ReturnType<typeof useScreenshotSelection>;
  actions: ReturnType<typeof useScreenshotActions>;
}

export function createScreenshotToolbar(context: CreateScreenshotToolbarContext) {
  const { state, panelStyle, selection, actions } = context;

  const toolbar = (state.phase === "annotate" || state.phase === "preview") && state.sel && !state.dragging && (
    <div
      ref={state.toolbarRef}
      data-testid="screenshot-toolbar"
      data-drawing={state.drawing}
      className={state.scrollResult ? "relative z-50 shrink-0 px-4 py-2" : "fixed z-50"}
      style={state.scrollResult ? { ...panelStyle, maxHeight: "40vh", overflowY: "auto" } : {
        left: state.toolbarPos?.left ?? -9999,
        top: state.toolbarPos?.top ?? -9999,
        width: Math.min(760, state.viewport.w - 16),
        maxHeight: state.viewport.h - 16,
        overflowY: "auto",
        opacity: state.drawing ? 0.15 : 1,
        pointerEvents: state.drawing ? "none" : "auto",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {(state.tool === "text" || state.textSelected) && <div data-testid="screenshot-text-style" className="flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 mb-1 text-[12px]" style={panelStyle}>
        <label className="flex items-center gap-2">{state.t("screenshot.fontFamily")}
          <select data-testid="screenshot-font-family" aria-label={state.t("screenshot.fontFamily")} className="taomni-input h-7 max-w-44" value={state.fontFamily}
            onChange={(e) => { state.setFontFamily(e.target.value); if (state.textSelected) state.canvasRef.current?.updateSelectedStyle({ fontFamily: e.target.value }); }}>
            <option value={FONT_STACK}>{state.t("screenshot.fontDefault")}</option>
            <option value="serif">{state.t("screenshot.fontSerif")}</option>
            <option value="monospace">{state.t("screenshot.fontMono")}</option>
            {state.systemFonts.map((font) => <option key={font} value={`${JSON.stringify(font)}, sans-serif`}>{font}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">{state.t("screenshot.fontSize")}
          <input data-testid="screenshot-font-size" aria-label={state.t("screenshot.fontSize")} type="number" min={8} max={144} step={1} value={state.fontSize}
            className="taomni-input h-7 w-16 px-2" onChange={(e) => { const value = e.target.valueAsNumber; if (Number.isFinite(value) && value >= 8 && value <= 144) { state.setFontSize(value); if (state.textSelected) state.canvasRef.current?.updateSelectedStyle({ fontSize: value }); } }} />
        </label>
        <span data-testid="screenshot-text-hint" className="text-[var(--taomni-text-muted)]">{state.t("screenshot.textHint")}</span>
      </div>}
      <div className="flex flex-wrap items-center gap-0.5 rounded-xl px-1.5 py-1 shadow-2xl" style={panelStyle}>
        {!state.scrollResult && <ToolButton testid="screenshot-selection-rectangle" title={state.t("screenshot.selectionRectangle")} active={state.selectionMode === "rectangle"} onClick={() => selection.changeSelectionMode("rectangle")}>
          <Square size={16} />
        </ToolButton>}
        {!state.scrollResult && <ToolButton testid="screenshot-selection-freehand" title={state.t("screenshot.selectionFreehand")} active={state.selectionMode === "freehand"} onClick={() => selection.changeSelectionMode("freehand")}>
          <Lasso size={16} />
        </ToolButton>}
        <div className="w-px h-5 mx-1" style={{ background: "var(--taomni-divider)" }} />
        {TOOLS.map(({ tool: name, testid, titleKey, Icon }) => (
          <ToolButton
            key={name}
            testid={testid}
            title={state.t(titleKey)}
            active={state.tool === name}
            onClick={() => {
              selection.exitPickerMode();
              state.setTool((cur) => (cur === name ? "select" : name));
            }}
          >
            <Icon size={16} />
          </ToolButton>
        ))}
        {(FILLABLE_TOOLS.includes(state.tool) || state.fillableSelected) && <button type="button" data-testid="screenshot-fill" aria-pressed={state.fill}
          title={state.t("screenshot.solidFill")} className="rounded px-2 h-8 text-[12px]" onClick={() => { state.setFill(!state.fill); if (state.fillableSelected) state.canvasRef.current?.updateSelectedStyle({ filled: !state.fill }); }}>
          {state.t(state.fill ? "screenshot.solidFill" : "screenshot.outlineFill")}
        </button>}
        {state.tool === "eraser" && <select data-testid="screenshot-eraser-mode" aria-label={state.t("screenshot.toolEraser")} className="taomni-input h-8 text-[12px]" value={state.eraserMode} onChange={(e) => state.setEraserMode(e.target.value as EraserMode)}>
          <option value="partial">{state.t("screenshot.erasePartial")}</option><option value="object">{state.t("screenshot.eraseObject")}</option>
        </select>}
        <div className="basis-full h-px my-1" style={{ background: "var(--taomni-divider)" }} />
        {COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            data-testid={c.testid}
            title={state.t(c.titleKey)}
            aria-label={state.t(c.titleKey)}
            aria-pressed={state.color === c.value}
            onClick={() => { state.setColor(c.value); if (state.tool === "move") state.canvasRef.current?.updateSelectedStyle({ color: c.value }); }}
            className="w-5 h-5 mx-0.5 rounded-full shrink-0"
            style={{
              background: c.value,
              outline: state.color === c.value ? "2px solid var(--taomni-accent)" : "1px solid rgba(128, 128, 128, 0.45)",
              outlineOffset: 1,
            }}
          />
        ))}
        <input type="color" data-testid="screenshot-color-custom" aria-label={state.t("screenshot.colorCustom")} title={state.t("screenshot.colorCustom")}
          value={state.color} className="w-7 h-7 mx-1 shrink-0 cursor-pointer rounded border border-[var(--taomni-divider)] p-0.5"
          onChange={(e) => { state.setColor(e.target.value); if (state.tool === "move") state.canvasRef.current?.updateSelectedStyle({ color: e.target.value }); }} />
        <input type="text" data-testid="screenshot-color-hex" aria-label={state.t("screenshot.colorHex")} title={state.t("screenshot.colorHex")} value={state.colorDraft} maxLength={7}
          className="taomni-input h-7 w-20 px-1 text-[11px] font-mono" spellCheck={false}
          onChange={(e) => { const value = e.target.value; state.setColorDraft(value); if (/^#[0-9a-fA-F]{6}$/.test(value)) { state.setColor(value.toLowerCase()); if (state.tool === "move") state.canvasRef.current?.updateSelectedStyle({ color: value.toLowerCase() }); } }}
          onBlur={() => state.setColorDraft(state.color)} />
        {LINE_WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            data-testid={`screenshot-line-width-${w}`}
            title={`${w}px`}
            aria-label={`${w}px`}
            aria-pressed={state.lineWidth === w}
            onClick={() => { state.setLineWidth(w); if (state.tool === "move") state.canvasRef.current?.updateSelectedStyle({ lineWidth: w }); }}
            className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
            style={{ background: state.lineWidth === w ? "var(--taomni-hover)" : "transparent", color: "var(--taomni-text)" }}
          >
            <span className="rounded-full" style={{ width: w + 3, height: w + 3, background: "currentColor" }} />
          </button>
        ))}
        <div className="w-px h-5 mx-1" style={{ background: "var(--taomni-divider)" }} />
        <ToolButton testid="screenshot-undo" title={state.t("screenshot.undo")} disabled={!state.canUndo} onClick={() => state.canvasRef.current?.undo()}>
          <Undo2 size={16} />
        </ToolButton>
        <ToolButton testid="screenshot-redo" title={state.t("screenshot.redo")} disabled={!state.canRedo} onClick={() => state.canvasRef.current?.redo()}>
          <Redo2 size={16} />
        </ToolButton>
        <ToolButton testid="screenshot-annotation-delete" title={state.t("screenshot.deleteAnnotation")} disabled={!state.annotationSelected} onClick={() => { state.canvasRef.current?.deleteSelected(); }}>
          <Trash2 size={16} />
        </ToolButton>
        <div className="w-px h-5 mx-1" style={{ background: "var(--taomni-divider)" }} />
        {!state.scrollResult && <ToolButton testid="screenshot-scroll-capture" title={state.t(state.contour ? "screenshot.rectangleRequired" : "screenshot.scrollCapture")} disabled={!!state.contour || !!state.scrollResult} onClick={() => void actions.confirmScroll()}>
          <ScrollText size={16} />
        </ToolButton>}
        {!state.scrollResult && <ToolButton testid="screenshot-recrop" title={state.t("screenshot.recrop")} active={state.tool === "select"} onClick={() => state.setTool("select")}><Crop size={16} /></ToolButton>}
        <ToolButton testid="screenshot-pin" title={state.t("screenshot.pinDescription")} onClick={() => void actions.handlePin()}><Pin size={16} /></ToolButton>
        <ToolButton testid="screenshot-edit" title={state.t("screenshot.editImage")} onClick={() => state.setEditOpen(true)}><SlidersHorizontal size={16} /></ToolButton>
        <ToolButton testid="screenshot-more" title={state.t("screenshot.moreTools")} active={state.moreOpen} onClick={() => state.setMoreOpen(!state.moreOpen)}><MoreHorizontal size={16} /></ToolButton>
        <div data-testid="screenshot-more-tools" className="flex flex-wrap items-center gap-0.5 basis-full" style={{ display: state.moreOpen ? "flex" : "none" }}>
          <ToolButton
            testid="screenshot-color-picker"
            title={state.t("screenshot.colorPicker")}
            active={state.pickerMode}
            onClick={() => (state.pickerMode ? selection.exitPickerMode() : selection.enterPickerMode())}
          >
            <Pipette size={16} />
          </ToolButton>
          <ToolButton testid="screenshot-ocr" title={state.t("screenshot.ocr")} onClick={() => void actions.handleOcr()}>
            <ScanText size={16} />
          </ToolButton>
          <ToolButton testid="screenshot-auto-redact" title={state.t("screenshot.autoRedact")} onClick={() => void actions.handleAutoRedact()}>
            <ShieldAlert size={16} />
          </ToolButton>
          <div ref={state.watermarkButtonRef} className="relative">
            <ToolButton
              testid="screenshot-watermark"
              title={state.t("screenshot.watermark")}
              active={state.watermarkOpen || state.watermark !== null}
              onClick={() => {
                state.setRecordOpen(false);
                state.setWatermarkOpen((v) => !v);
              }}
            >
              <Stamp size={16} />
            </ToolButton>
            {state.watermarkOpen && (
              <div
                ref={state.watermarkPanelRef}
                data-testid="screenshot-watermark-panel"
                className="fixed rounded-lg shadow-2xl p-3 overflow-y-auto"
                style={{ zIndex: 65, width: Math.min(224, state.viewport.w - 16), maxHeight: state.viewport.h - 16, ...state.watermarkPos, ...panelStyle }}
              >
                <input
                  type="text"
                  data-testid="screenshot-watermark-text"
                  value={state.watermarkText}
                  maxLength={120}
                  onChange={(e) => state.setWatermarkText(e.target.value)}
                  placeholder={state.t("screenshot.watermarkPlaceholder")}
                  aria-label={state.t("screenshot.watermarkPlaceholder")}
                  className="taomni-input w-full h-7 px-2 text-[13px] mb-2"
                />
                <label className="flex items-center gap-2 text-[12px] mb-2">
                  <span className="shrink-0">{state.t("screenshot.watermarkOpacity")}</span>
                  <input
                    type="range"
                    data-testid="screenshot-watermark-opacity"
                    min={10}
                    max={80}
                    value={Math.round(state.watermarkOpacity * 100)}
                    onChange={(e) => state.setWatermarkOpacity(Number(e.target.value) / 100)}
                    className="min-w-0 flex-1"
                  />
                  <span className="w-8 text-right font-mono">{Math.round(state.watermarkOpacity * 100)}%</span>
                </label>
                <div className="flex items-center gap-1.5 mb-3">
                  {["#ffffff", "#000000", "#ff4444", "#ffcc00", "#00aaff"].map((c) => (
                    <button
                      key={c}
                      type="button"
                      data-testid={`screenshot-watermark-color-${c.slice(1)}`}
                      aria-label={c}
                      onClick={() => state.setWatermarkColor(c)}
                      className="w-5 h-5 rounded-full shrink-0"
                      style={{
                        background: c,
                        outline: state.watermarkColor === c ? "2px solid var(--taomni-accent)" : "1px solid rgba(128,128,128,0.45)",
                        outlineOffset: 1,
                      }}
                    />
                  ))}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    data-testid="screenshot-watermark-apply"
                    onClick={() => {
                      if (state.watermarkText.trim()) {
                        state.setWatermark({ text: state.watermarkText.trim(), opacity: state.watermarkOpacity, color: state.watermarkColor, seed: state.watermark?.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] });
                      }
                      state.setWatermarkOpen(false);
                    }}
                    className="flex-1 rounded px-2 py-1 text-[13px]"
                    style={{ background: "var(--taomni-accent)", color: "#ffffff" }}
                  >
                    {state.t("screenshot.watermarkApply")}
                  </button>
                  <button
                    type="button"
                    data-testid="screenshot-watermark-clear"
                    onClick={() => {
                      state.setWatermark(null);
                      state.setWatermarkText("");
                      state.setWatermarkOpen(false);
                    }}
                    className="rounded px-2 py-1 text-[13px]"
                    style={{ border: "1px solid var(--taomni-divider)" }}
                  >
                    {state.t("screenshot.watermarkClear")}
                  </button>
                </div>
              </div>
            )}
          </div>
          {!state.scrollResult && <div ref={state.recordButtonRef} className="relative">
            <ToolButton
              testid="screenshot-record"
              title={state.t(state.contour ? "screenshot.rectangleRequired" : "screenshot.record")}
              disabled={!!state.contour || !!state.scrollResult}
              active={state.recordOpen}
              onClick={() => {
                state.setWatermarkOpen(false);
                state.setRecordOpen((v) => !v);
              }}
            >
              <span className="flex items-center">
                <Video size={16} />
                <ChevronDown size={12} />
              </span>
            </ToolButton>
            {state.recordOpen && (
              <div
                ref={state.recordMenuRef}
                data-testid="screenshot-record-menu"
                className="fixed rounded-xl p-2 shadow-2xl text-[13px] overflow-y-auto"
                style={{ zIndex: 65, width: Math.min(320, state.viewport.w - 16), maxHeight: state.viewport.h - 16, ...state.recordPos, ...panelStyle }}
              >
                <p data-testid="screenshot-record-hint" className="px-2 py-2 leading-relaxed whitespace-normal break-words text-[var(--taomni-text-muted)]">{state.t("screenshot.recordHint", { shortcut: state.stopShortcut || state.t("settings.screenshotDisabled") })}</p>
                <button
                  type="button"
                  data-testid="screenshot-record-gif"
                  onClick={() => void actions.handleRecord("gif")}
                  className="block w-full text-left px-4 py-1.5 hover:bg-[var(--taomni-hover)]"
                >
                  {state.t("screenshot.recordGif")}
                </button>
                <button
                  type="button"
                  data-testid="screenshot-record-mp4"
                  onClick={() => void actions.handleRecord("mp4")}
                  className="block w-full text-left px-4 py-1.5 hover:bg-[var(--taomni-hover)]"
                >
                  {state.t("screenshot.recordMp4")}
                </button>
              </div>
            )}
          </div>}
        </div>
        <div className="w-px h-5 mx-1" style={{ background: "var(--taomni-divider)" }} />
        {!state.scrollResult && <><ToolButton testid="screenshot-cancel" title={`${state.t("screenshot.cancel")} (Esc)`} onClick={state.close}>
          <X size={16} />
        </ToolButton>
          <ToolButton testid="screenshot-save" title={`${state.t("screenshot.save")} (Ctrl+S)`} onClick={() => void actions.handleSave()}>
            <Download size={16} />
          </ToolButton>
          <button
            type="button"
            data-testid="screenshot-copy"
            title={`${state.t("screenshot.copy")} (Enter / Ctrl+C)`}
            onClick={() => void actions.handleCopy()}
            className="ml-1 h-8 shrink-0 rounded-lg px-3 flex items-center gap-1 text-[13px] font-medium"
            style={{ background: "var(--taomni-accent)", color: "#ffffff" }}
          >
            <Check size={15} />
            {state.t("screenshot.done")}
          </button></>}
      </div>
    </div>
  );
  return { toolbar };
}
