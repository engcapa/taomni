import { useMemo, useRef, useState, useCallback } from "react";
import { ArrowDown, ArrowUp, Copy } from "lucide-react";
import type { DbQueryResult } from "../../lib/ipc";
import { useContextMenu, type MenuItem } from "../ContextMenu";

const ROW_HEIGHT = 24;
const OVERSCAN = 12;

interface QueryResultGridProps {
  result: DbQueryResult;
}

type SortDir = "asc" | "desc" | null;

/** Detect a numeric column value for right-alignment + numeric sort. */
function isNumeric(value: string | null): boolean {
  if (value === null || value === "") return false;
  return !Number.isNaN(Number(value));
}

function csvEscape(value: string | null): string {
  if (value === null) return "";
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** A virtualised result grid: only the visible row window is rendered, so
 *  10 000+ rows scroll without layout jank. */
export function QueryResultGrid({ result }: QueryResultGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const { show: openMenu, render: menu } = useContextMenu();

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
    setViewportH(e.currentTarget.clientHeight);
  }, []);

  // Sorted row index order (stable: only reorders a view, not the data).
  const order = useMemo(() => {
    const idx = result.rows.map((_, i) => i);
    if (sortCol === null || sortDir === null) return idx;
    const numeric = result.rows.every((r) => isNumeric(r[sortCol]));
    idx.sort((a, b) => {
      const va = result.rows[a][sortCol];
      const vb = result.rows[b][sortCol];
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      let cmp: number;
      if (numeric) cmp = Number(va) - Number(vb);
      else cmp = va.localeCompare(vb);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return idx;
  }, [result.rows, sortCol, sortDir]);

  const toggleSort = (col: number) => {
    if (sortCol !== col) {
      setSortCol(col);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortCol(null);
      setSortDir(null);
    }
  };

  const total = order.length;
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endRow = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);
  const visible = order.slice(startRow, endRow);

  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  const cellMenu = (rowIdx: number, colIdx: number): MenuItem[] => {
    const row = result.rows[rowIdx];
    return [
      {
        label: "Copy cell",
        icon: <Copy className="w-3.5 h-3.5" />,
        onClick: () => copyText(row[colIdx] ?? ""),
      },
      {
        label: "Copy row",
        onClick: () => copyText(row.map((c) => c ?? "").join("\t")),
      },
      {
        label: "Copy row as CSV",
        onClick: () => copyText(row.map(csvEscape).join(",")),
      },
    ];
  };

  if (result.columns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--moba-text-muted)]">
        {result.rowsAffected > 0
          ? `${result.rowsAffected} row(s) affected`
          : "Statement executed. No result set."}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="query-result-grid">
      {/* Header */}
      <div
        className="flex shrink-0 text-[11px] font-semibold select-none"
        style={{ background: "var(--moba-quick-bg)", borderBottom: "1px solid var(--moba-divider)" }}
      >
        <div className="w-12 px-1 py-1 text-right text-[var(--moba-text-muted)] shrink-0" style={{ borderRight: "1px solid var(--moba-divider)" }}>#</div>
        {result.columns.map((col, c) => (
          <button
            key={c}
            type="button"
            className="flex-1 min-w-[120px] px-2 py-1 text-left flex items-center gap-1 hover:bg-[var(--moba-hover)]"
            style={{ borderRight: "1px solid var(--moba-divider)" }}
            onClick={() => toggleSort(c)}
            title={`${col.name} (${col.type})`}
          >
            <span className="truncate flex-1">{col.name}</span>
            {sortCol === c && sortDir === "asc" && <ArrowUp className="w-3 h-3" />}
            {sortCol === c && sortDir === "desc" && <ArrowDown className="w-3 h-3" />}
          </button>
        ))}
      </div>

      {/* Virtualised body */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto moba-scroll-y"
        onScroll={onScroll}
        style={{ fontSize: 12 }}
      >
        <div style={{ height: total * ROW_HEIGHT, position: "relative" }}>
          {visible.map((rowIdx, i) => {
            const row = result.rows[rowIdx];
            const top = (startRow + i) * ROW_HEIGHT;
            return (
              <div
                key={rowIdx}
                className="flex absolute left-0 right-0 hover:bg-[var(--moba-hover)]"
                style={{ top, height: ROW_HEIGHT, borderBottom: "1px solid var(--moba-divider)" }}
              >
                <div
                  className="w-12 px-1 text-right text-[var(--moba-text-muted)] shrink-0 flex items-center justify-end"
                  style={{ borderRight: "1px solid var(--moba-divider)" }}
                >
                  {rowIdx + 1}
                </div>
                {row.map((cell, c) => (
                  <div
                    key={c}
                    className={`flex-1 min-w-[120px] px-2 flex items-center truncate ${
                      isNumeric(cell) ? "justify-end font-mono" : ""
                    }`}
                    style={{ borderRight: "1px solid var(--moba-divider)" }}
                    title={cell ?? "NULL"}
                    onContextMenu={(e) => openMenu(e, cellMenu(rowIdx, c))}
                  >
                    {cell === null ? (
                      <span
                        className="text-[10px] px-1 rounded"
                        style={{ background: "var(--moba-divider)", color: "var(--moba-text-muted)" }}
                      >
                        NULL
                      </span>
                    ) : (
                      <span className="truncate">{cell}</span>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {menu}
    </div>
  );
}
