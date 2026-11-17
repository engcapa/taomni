import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { getAppPlatform } from "../../../lib/runtime";
import { ROW_HEIGHT } from "./model";
import type { GridRow, ViewMode } from "./types";

interface Match { rowId: string; colIdx: number; rowIndex: number }
interface Inputs {
  orderedRows: GridRow[];
  visibleColumnIndexes: number[];
  containerRef: RefObject<HTMLDivElement | null>;
  setActiveCell: (cell: { rowId: string; colIdx: number }) => void;
  setViewMode: (mode: ViewMode) => void;
  viewMode: ViewMode;
  scrollTop: number;
  setScrollTop: (value: number) => void;
  setScrollLeft: (value: number) => void;
  columnWidths: Record<number, number>;
  autoFit: boolean;
}

/** Search owns match navigation; filtering, row selection and edits remain separate. */
export function useGridSearch(inputs: Inputs) {
  const { orderedRows, visibleColumnIndexes, containerRef, setActiveCell, setViewMode,
    viewMode, scrollTop, setScrollTop, setScrollLeft, columnWidths, autoFit } = inputs;
  const [text, setText] = useState("");
  const needle = text.trim().toLowerCase();
  const inputRef = useRef<HTMLInputElement>(null);
  const [anchor, setAnchor] = useState<(Match & { needle: string }) | null>(null);
  const matches = useMemo(() => {
    const found: Match[] = [];
    if (needle) orderedRows.forEach((row, rowIndex) => {
      visibleColumnIndexes.forEach((colIdx) => {
        if ((row.values[colIdx] ?? "").toLowerCase().includes(needle)) found.push({ rowId: row.id, colIdx, rowIndex });
      });
    });
    return found;
  }, [orderedRows, visibleColumnIndexes, needle]);
  const found = anchor?.needle === needle ? matches.findIndex((match) => match.rowId === anchor.rowId && match.colIdx === anchor.colIdx) : -1;
  const index = matches.length ? Math.max(0, found) : -1;
  const current = matches[index];
  const move = (direction: 1 | -1) => {
    if (!matches.length) return;
    const match = matches[(index + direction + matches.length) % matches.length];
    setAnchor({ ...match, needle });
    setViewMode("table");
    setActiveCell(match);
  };

  useLayoutEffect(() => {
    if (current) { setViewMode("table"); setActiveCell(current); }
  }, [current, setActiveCell, setViewMode]);

  useLayoutEffect(() => {
    const body = containerRef.current;
    if (!current || !body || viewMode !== "table") return;
    const top = current.rowIndex * ROW_HEIGHT;
    const height = body.clientHeight || 400;
    const next = top < body.scrollTop ? top : top + ROW_HEIGHT > body.scrollTop + height ? top + ROW_HEIGHT - height : body.scrollTop;
    if (next !== body.scrollTop) { body.scrollTop = next; setScrollTop(next); }
    // The first render can precede mounting a virtual row. The scroll state
    // above mounts it, then this effect resolves horizontal geometry as well.
    const row = Array.from(body.querySelectorAll<HTMLElement>("[data-row-id]")).find((node) => node.dataset.rowId === current.rowId);
    const cell = row?.querySelector<HTMLElement>(`[data-column-index="${current.colIdx}"]`);
    if (!cell || !body.clientWidth) return;
    const left = cell.offsetLeft;
    const right = left + cell.offsetWidth;
    const nextLeft = left < body.scrollLeft || cell.offsetWidth > body.clientWidth ? left
      : right > body.scrollLeft + body.clientWidth ? right - body.clientWidth : body.scrollLeft;
    if (nextLeft !== body.scrollLeft) { body.scrollLeft = nextLeft; setScrollLeft(nextLeft); }
  }, [current, viewMode, scrollTop, containerRef, setScrollTop, setScrollLeft, columnWidths, autoFit]);

  const mac = getAppPlatform() === "macos";
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('[role="dialog"]')) return;
    const inSearch = target === inputRef.current;
    if (!inSearch && target.closest('input,textarea,select,[contenteditable="true"],.cm-editor')) return;
    const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault(); event.stopPropagation(); inputRef.current?.focus(); inputRef.current?.select();
    } else if ((!event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "F3" || (inSearch && event.key === "Enter")))
      || (mac && mod && !event.altKey && event.key.toLowerCase() === "g")) {
      event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1);
    } else if (inSearch && event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.stopPropagation(); setText(""); containerRef.current?.focus();
    }
  };
  return { text, setText, needle, inputRef, count: matches.length, position: index + 1, current, move, handleKeyDown, mac };
}
