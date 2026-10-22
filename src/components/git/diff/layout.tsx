import { EditorView } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";

export const CONNECTOR_WIDTH = 36;

export const MIN_PANE_WIDTH = 160;

export const MIN_SPLIT_CONTENT_WIDTH = MIN_PANE_WIDTH * 2;


export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}


export function setImportantStyle(element: HTMLElement, property: string, value: string) {
  element.style.setProperty(property, value, "important");
}


export function setImportantStyleIfChanged(element: HTMLElement, property: string, value: string): boolean {
  if (element.style.getPropertyValue(property) === value && element.style.getPropertyPriority(property) === "important") {
    return false;
  }
  setImportantStyle(element, property, value);
  return true;
}


export function elementWidth(element: HTMLElement): number {
  if (element.clientWidth > 0) return element.clientWidth;
  const width = element.getBoundingClientRect().width;
  return Number.isFinite(width) && width > 0 ? width : 0;
}


export interface SplitLayoutMetrics {
  width: number;
  availableWidth: number;
  leftWidth: number;
  rightWidth: number;
  effectiveRatio: number;
  disabled: boolean;
}


export function splitLayoutMetrics(editorDom: HTMLElement, preferredRatio: number): SplitLayoutMetrics {
  const width = elementWidth(editorDom);
  const availableWidth = Math.max(0, width - CONNECTOR_WIDTH);
  const disabled = availableWidth < MIN_SPLIT_CONTENT_WIDTH;
  if (availableWidth === 0) {
    return { width, availableWidth, leftWidth: 0, rightWidth: 0, effectiveRatio: 0.5, disabled: true };
  }
  if (disabled) {
    const half = availableWidth / 2;
    return { width, availableWidth, leftWidth: half, rightWidth: half, effectiveRatio: 0.5, disabled: true };
  }
  const minRatio = MIN_PANE_WIDTH / availableWidth;
  const effectiveRatio = clampNumber(preferredRatio, minRatio, 1 - minRatio);
  const leftWidth = availableWidth * effectiveRatio;
  return {
    width,
    availableWidth,
    leftWidth,
    rightWidth: availableWidth - leftWidth,
    effectiveRatio,
    disabled: false,
  };
}


export function applyEditorViewportLayout(view: EditorView) {
  const editor = view.dom;
  const scroller = view.scrollDOM;

  setImportantStyle(editor, "display", "flex");
  setImportantStyle(editor, "flex-direction", "column");
  setImportantStyle(editor, "height", "100%");
  setImportantStyle(editor, "width", "100%");
  setImportantStyle(editor, "min-height", "0");
  setImportantStyle(editor, "min-width", "0");
  setImportantStyle(editor, "overflow", "hidden");
  editor.style.setProperty("flex", "1 1 auto");

  scroller.style.setProperty("flex", "1 1 auto");
  setImportantStyle(scroller, "height", "100%");
  setImportantStyle(scroller, "width", "100%");
  setImportantStyle(scroller, "min-height", "0");
  setImportantStyle(scroller, "min-width", "0");
  setImportantStyle(scroller, "overflow-x", "auto");
  setImportantStyle(scroller, "overflow-y", "auto");
}


export function applySplitDiffLayout(
  mv: MergeView,
  preferredRatio: number,
): ({
  editorDom: HTMLElement;
  leftWrap: HTMLElement;
  rightWrap: HTMLElement;
} & SplitLayoutMetrics) | null {
  const editorDom = mv.dom.querySelector<HTMLElement>(".cm-mergeViewEditors");
  const leftWrap = mv.a.dom.parentElement;
  const rightWrap = mv.b.dom.parentElement;
  if (
    !editorDom ||
    !leftWrap ||
    !rightWrap ||
    leftWrap.parentElement !== editorDom ||
    rightWrap.parentElement !== editorDom
  ) {
    return null;
  }

  setImportantStyle(mv.dom, "display", "flex");
  setImportantStyle(mv.dom, "flex-direction", "column");
  setImportantStyle(mv.dom, "height", "100%");
  setImportantStyle(mv.dom, "width", "100%");
  setImportantStyle(mv.dom, "min-height", "0");
  setImportantStyle(mv.dom, "min-width", "0");
  setImportantStyle(mv.dom, "overflow", "hidden");

  setImportantStyle(editorDom, "display", "flex");
  setImportantStyle(editorDom, "flex-direction", "row");
  setImportantStyle(editorDom, "align-items", "stretch");
  editorDom.style.setProperty("flex", "1 1 auto");
  setImportantStyle(editorDom, "height", "100%");
  setImportantStyle(editorDom, "width", "100%");
  setImportantStyle(editorDom, "min-height", "0");
  setImportantStyle(editorDom, "min-width", "0");
  setImportantStyle(editorDom, "overflow", "hidden");

  for (const wrap of [leftWrap, rightWrap]) {
    // Column so the nested .cm-editor stretches to the full pane width;
    // row (the previous default) sized editors to content and left the
    // scrollbar floating mid-panel instead of on each pane's right edge.
    setImportantStyle(wrap, "display", "flex");
    setImportantStyle(wrap, "flex-direction", "column");
    setImportantStyle(wrap, "align-items", "stretch");
    setImportantStyle(wrap, "min-height", "0");
    setImportantStyle(wrap, "min-width", "0");
    setImportantStyle(wrap, "overflow", "hidden");
  }

  const metrics = splitLayoutMetrics(editorDom, preferredRatio);
  const shouldApplyMeasuredWidths = metrics.width > CONNECTOR_WIDTH;
  const leftFlex = shouldApplyMeasuredWidths ? `0 0 ${metrics.leftWidth}px` : "1 1 0";
  const rightFlex = shouldApplyMeasuredWidths ? `0 0 ${metrics.rightWidth}px` : "1 1 0";
  const leftWidth = shouldApplyMeasuredWidths ? `${metrics.leftWidth}px` : "auto";
  const rightWidth = shouldApplyMeasuredWidths ? `${metrics.rightWidth}px` : "auto";
  const leftFlexChanged = setImportantStyleIfChanged(leftWrap, "flex", leftFlex);
  const leftWidthChanged = setImportantStyleIfChanged(leftWrap, "width", leftWidth);
  const rightFlexChanged = setImportantStyleIfChanged(rightWrap, "flex", rightFlex);
  const rightWidthChanged = setImportantStyleIfChanged(rightWrap, "width", rightWidth);
  const leftChanged = leftFlexChanged || leftWidthChanged;
  const rightChanged = rightFlexChanged || rightWidthChanged;

  applyEditorViewportLayout(mv.a);
  applyEditorViewportLayout(mv.b);
  if (leftChanged || rightChanged) {
    mv.a.requestMeasure();
    mv.b.requestMeasure();
  }

  return { editorDom, leftWrap, rightWrap, ...metrics };
}
