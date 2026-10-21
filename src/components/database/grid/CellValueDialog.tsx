import { useEffect, useRef, useState } from "react";
import { Copy, FileText, X } from "lucide-react";
import { type CellValueViewer } from "./types";


export function CellValueDialog({
  viewer,
  onCopy,
  onClose,
}: {
  viewer: CellValueViewer;
  onCopy: () => void;
  onClose: () => void;
}) {
  const [wrap, setWrap] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const text = viewer.value ?? "NULL";
  const charCount = viewer.value?.length ?? 0;
  const lineCount = viewer.value == null ? 0 : viewer.value.split(/\r\n|\r|\n/).length;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45"
      onMouseDown={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Full value for ${viewer.column.name}`}
        data-testid="query-cell-value-dialog"
        className="w-[760px] max-w-[92vw] max-h-[86vh] flex flex-col rounded shadow-xl"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)", color: "var(--taomni-text)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="h-10 shrink-0 flex items-center gap-2 px-3" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
          <FileText className="w-4 h-4 text-[var(--taomni-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold" title={viewer.column.name}>
              {viewer.column.name}
            </div>
            <div className="truncate text-[10px] text-[var(--taomni-text-muted)]">
              Row {viewer.rowNumber} | {viewer.column.type} | {charCount} chars | {lineCount} lines
            </div>
          </div>
          <label className="h-6 inline-flex items-center gap-1 px-1 text-[11px] text-[var(--taomni-text-muted)]">
            <input
              data-testid="query-cell-value-wrap"
              type="checkbox"
              checked={wrap}
              onChange={(event) => setWrap(event.target.checked)}
            />
            Wrap
          </label>
          <button
            type="button"
            data-testid="query-cell-value-copy"
            className="h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)]"
            title="Copy full value"
            onClick={onCopy}
          >
            <Copy className="w-3.5 h-3.5" /> Copy
          </button>
          <button
            type="button"
            className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
            aria-label="Close full value"
            onClick={onClose}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          data-testid="query-cell-value-text"
          className={`m-3 min-h-[280px] max-h-[calc(86vh-96px)] flex-1 resize-none rounded p-2 text-[12px] font-mono ${
            wrap ? "whitespace-pre-wrap" : "whitespace-pre"
          }`}
          style={{
            background: "var(--taomni-panel-bg)",
            border: "1px solid var(--taomni-divider)",
            color: viewer.value == null ? "var(--taomni-text-muted)" : "var(--taomni-text)",
            overflow: "auto",
          }}
          wrap={wrap ? "soft" : "off"}
          readOnly
          value={text}
        />
      </div>
    </div>
  );
}
