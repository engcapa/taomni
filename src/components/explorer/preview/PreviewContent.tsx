import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { parseCsvPreview, renderOfflineMarkdown } from "./previewModel";

export function TextPreview({ text, wrap }: { text: string; wrap: boolean }) {
  const lines = useMemo(() => text.split(/\r\n|\n|\r/), [text]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 17.05,
    initialRect: { width: 276, height: 300 },
    overscan: 8,
    useAnimationFrameWithResizeObserver: true,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, text, wrap]);

  return (
    <div ref={scrollRef} data-testid="explorer-preview-text" data-line-count={lines.length} className={`ex-pv-text${wrap ? " ex-pv-wrap" : ""}`}>
      <div className="ex-pv-lines" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            ref={virtualizer.measureElement}
            data-index={row.index}
            className="ex-pv-line"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            <span className="ex-pv-ln" aria-hidden="true">{row.index + 1}</span>
            <span className="ex-pv-line-content">{lines[row.index] || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MarkdownFilePreview({ text }: { text: string }) {
  const html = useMemo(() => renderOfflineMarkdown(text), [text]);
  return <div data-testid="explorer-preview-markdown" className="ex-pv-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function CsvFilePreview({ text, rowsLabel }: { text: string; rowsLabel: string }) {
  const preview = useMemo(() => parseCsvPreview(text), [text]);
  return (
    <div>
      <div data-testid="explorer-preview-csv" className="ex-pv-csv">
        <table>
          <tbody>
            {preview.rows.map((row, index) => (
              <tr key={index}>
                {row.map((field, column) => index === 0 ? <th key={column}>{field}</th> : <td key={column}>{field}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.truncated && <div className="ex-pv-hint">{rowsLabel}</div>}
    </div>
  );
}
