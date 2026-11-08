import { useMemo, useRef, useState, type MouseEvent } from "react";
import { open as tauriOpen } from "@tauri-apps/plugin-shell";
import { useT } from "../../lib/i18n";
import { extractNoteUrls, findNoteUrlAtIndex } from "../../lib/notes/noteLinks";
import { isTauriRuntime } from "../../lib/runtime";
import { renderLinkedNoteText } from "./NoteLinkText";

let noteTextMeasureContext: CanvasRenderingContext2D | null | undefined;

function getTextMeasureContext(): CanvasRenderingContext2D | null {
  if (noteTextMeasureContext !== undefined) return noteTextMeasureContext;
  if (typeof document === "undefined") {
    noteTextMeasureContext = null;
    return noteTextMeasureContext;
  }
  noteTextMeasureContext = document.createElement("canvas").getContext("2d");
  return noteTextMeasureContext;
}

function syncMeasureFont(ctx: CanvasRenderingContext2D, element: HTMLElement) {
  const style = window.getComputedStyle(element);
  ctx.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

function textIndexAtX(ctx: CanvasRenderingContext2D, line: string, startIndex: number, x: number): number {
  if (x <= 0) return startIndex;
  let previousWidth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const width = ctx.measureText(line.slice(0, i + 1)).width;
    if (x < (previousWidth + width) / 2) return startIndex + i;
    previousWidth = width;
  }
  return startIndex + line.length;
}

function pointToInputTextIndex(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  clientX: number,
  clientY: number,
): number | null {
  const ctx = getTextMeasureContext();
  if (!ctx) return null;
  const style = window.getComputedStyle(element);
  syncMeasureFont(ctx, element);
  const rect = element.getBoundingClientRect();
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const fontSize = Number.parseFloat(style.fontSize) || 12;
  const parsedLineHeight = Number.parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : fontSize * 1.35;
  const x = clientX - rect.left - paddingLeft + element.scrollLeft;

  if (element instanceof HTMLInputElement) {
    return textIndexAtX(ctx, text, 0, x);
  }

  const y = clientY - rect.top - paddingTop + element.scrollTop;
  const contentWidth = Math.max(1, element.clientWidth - paddingLeft - paddingRight);
  const lines: Array<{ start: number; text: string }> = [];
  let lineStart = 0;
  let lineText = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\n") {
      lines.push({ start: lineStart, text: lineText });
      lineStart = i + 1;
      lineText = "";
      continue;
    }
    const next = `${lineText}${char}`;
    if (lineText && ctx.measureText(next).width > contentWidth) {
      lines.push({ start: lineStart, text: lineText });
      lineStart = i;
      lineText = char;
    } else {
      lineText = next;
    }
  }
  lines.push({ start: lineStart, text: lineText });
  const visualLineIndex = Math.max(0, Math.min(lines.length - 1, Math.floor(y / lineHeight)));
  const line = lines[visualLineIndex];
  return textIndexAtX(ctx, line.text, line.start, x);
}

interface NoteTextFieldProps {
  kind: "title" | "body";
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}

/** Compact editing and link preview share a field, but never draw competing focused text. */
export function NoteTextField({ kind, value, onChange, onBlur }: NoteTextFieldProps) {
  const t = useT();
  const [cursor, setCursor] = useState<"text" | "pointer">("text");
  const overlay = useRef<HTMLDivElement>(null);
  const hasUrl = useMemo(() => extractNoteUrls(value).length > 0, [value]);
  const preview = useMemo(() => renderLinkedNoteText(value), [value]);
  const testId = `note-editor-${kind}`;
  const title = kind === "title";
  const onClick = (event: MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const match = findNoteUrlAtIndex(value, event.currentTarget.selectionStart ?? 0);
    if (!match) return;
    event.preventDefault();
    if (isTauriRuntime()) {
      void tauriOpen(match.url).catch((error) => console.error("notes: failed to open URL", error));
    } else {
      const opened = window.open(match.url, "_blank", "noopener,noreferrer");
      if (opened) opened.opener = null;
    }
  };
  const onMouseMove = (event: MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!hasUrl) { setCursor("text"); return; }
    const index = pointToInputTextIndex(event.currentTarget, value, event.clientX, event.clientY);
    setCursor(index !== null && findNoteUrlAtIndex(value, index) ? "pointer" : "text");
  };
  const props = {
    value, onBlur, onClick, onMouseMove,
    onMouseLeave: () => setCursor("text"),
    style: { cursor },
    placeholder: t(title ? "notes.titlePlaceholder" : "notes.bodyPlaceholder"),
    "aria-label": t(title ? "notes.titlePlaceholder" : "notes.bodyPlaceholder"),
    "data-testid": testId,
    "data-has-url": hasUrl || undefined,
  };
  return <div className="notes-link-field-shell" data-has-url={hasUrl || undefined}>
    {hasUrl && <div ref={overlay} aria-hidden="true" data-testid={`${testId}-link-preview`}
      className={`notes-link-overlay ${title ? "notes-link-overlay-title text-[13px] font-semibold" : "notes-link-overlay-body text-[12px]"}`}>
      {preview}
    </div>}
    {title ? <input {...props} type="text" className="taomni-input h-7 text-[13px] font-semibold w-full"
      onChange={(event) => onChange(event.target.value)} />
      : <textarea {...props} className="taomni-input notes-link-textarea text-[12px] w-full resize-none min-h-[80px]" rows={4}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (overlay.current) {
            overlay.current.scrollTop = event.currentTarget.scrollTop;
            overlay.current.scrollLeft = event.currentTarget.scrollLeft;
          }
        }} />}
  </div>;
}
