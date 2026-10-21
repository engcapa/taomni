import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { isGridBlockSelectionMouseEvent } from "./model";
import { type GridBlockSelection, type GridRow } from "./types";


export interface UseGridSelectionContext {
  result: import("../../../lib/ipc").DbQueryResult;
  orderedRows: GridRow[];
  visibleColumnIndexes: number[];
  containerRef: import("react").RefObject<HTMLDivElement | null>;
}

export function useGridSelection(context: UseGridSelectionContext) {
  const { result, orderedRows, visibleColumnIndexes, containerRef } = context;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [cellBlockSelection, setCellBlockSelection] = useState<GridBlockSelection | null>(null);
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [activeCell, setActiveCell] = useState<{ rowId: string; colIdx: number; } | null>(null);

  useEffect(() => {
    if (!cellBlockSelection?.dragging) return;
    const finishDrag = () => {
      setCellBlockSelection((current) => current ? { ...current, dragging: false } : current);
    };
    document.addEventListener("mouseup", finishDrag);
    return () => document.removeEventListener("mouseup", finishDrag);
  }, [cellBlockSelection?.dragging]);

  useEffect(() => {
    setSelectedIds(new Set());
    setCellBlockSelection(null);
    setLastSelectedId(null);
    setActiveCell(null);
  }, [result]);
  useEffect(() => setCellBlockSelection(null), [result.columns]);

  const selectedRows = useMemo(
    () => orderedRows.filter((row) => selectedIds.has(row.id) && row.status !== "deleted"),
    [orderedRows, selectedIds],
  );
  const cellBlockRange = useMemo(() => {
    if (!cellBlockSelection) return null;
    const anchorRow = orderedRows.findIndex((row) => row.id === cellBlockSelection.anchor.rowId);
    const focusRow = orderedRows.findIndex((row) => row.id === cellBlockSelection.focus.rowId);
    const anchorCol = visibleColumnIndexes.indexOf(cellBlockSelection.anchor.colIdx);
    const focusCol = visibleColumnIndexes.indexOf(cellBlockSelection.focus.colIdx);
    if (anchorRow < 0 || focusRow < 0 || anchorCol < 0 || focusCol < 0) return null;

    const [rowStart, rowEnd] = anchorRow <= focusRow ? [anchorRow, focusRow] : [focusRow, anchorRow];
    const [colStart, colEnd] = anchorCol <= focusCol ? [anchorCol, focusCol] : [focusCol, anchorCol];
    const rowsInRange = orderedRows
      .slice(rowStart, rowEnd + 1)
      .filter((row) => row.status !== "deleted");
    const colIdxs = visibleColumnIndexes.slice(colStart, colEnd + 1);
    return {
      rows: rowsInRange,
      rowIds: new Set(rowsInRange.map((row) => row.id)),
      colIdxs,
      colIdxSet: new Set(colIdxs),
    };
  }, [cellBlockSelection, orderedRows, visibleColumnIndexes]);
  const selectionRows = cellBlockRange?.rows ?? selectedRows;
  const selectionRowCount = selectionRows.length;

  const startCellBlockSelection = (event: MouseEvent<HTMLElement>, rowId: string, colIdx: number) => {
    if (!isGridBlockSelectionMouseEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const cell = { rowId, colIdx };
    setSelectedIds(new Set());
    setLastSelectedId(null);
    setActiveCell(cell);
    setCellBlockSelection({ anchor: cell, focus: cell, dragging: true });
    containerRef.current?.focus();
  };

  const extendCellBlockSelection = (rowId: string, colIdx: number) => {
    setCellBlockSelection((current) => {
      if (!current?.dragging) return current;
      return { ...current, focus: { rowId, colIdx } };
    });
  };

  const extendCellBlockSelectionByKeyboard = (key: string) => {
    const origin = cellBlockSelection?.anchor ?? activeCell;
    const focus = cellBlockSelection?.focus ?? activeCell;
    if (!origin || !focus || orderedRows.length === 0 || visibleColumnIndexes.length === 0) return false;

    const currentRowPos = orderedRows.findIndex((row) => row.id === focus.rowId);
    const currentColPos = visibleColumnIndexes.indexOf(focus.colIdx);
    if (currentRowPos < 0 || currentColPos < 0) return false;

    let nextRowPos = currentRowPos;
    let nextColPos = currentColPos;
    if (key === "ArrowUp") nextRowPos -= 1;
    if (key === "ArrowDown") nextRowPos += 1;
    if (key === "ArrowLeft") nextColPos -= 1;
    if (key === "ArrowRight") nextColPos += 1;
    nextRowPos = Math.max(0, Math.min(orderedRows.length - 1, nextRowPos));
    nextColPos = Math.max(0, Math.min(visibleColumnIndexes.length - 1, nextColPos));

    const next = {
      rowId: orderedRows[nextRowPos].id,
      colIdx: visibleColumnIndexes[nextColPos],
    };
    setSelectedIds(new Set());
    setLastSelectedId(null);
    setActiveCell(next);
    setCellBlockSelection({ anchor: origin, focus: next, dragging: false });
    return true;
  };

  const selectRow = (rowId: string, event: MouseEvent<HTMLElement>) => {
    setCellBlockSelection(null);
    const orderedIds = orderedRows.map((row) => row.id);
    setSelectedIds((current) => {
      if (event.shiftKey && lastSelectedId && orderedIds.includes(lastSelectedId)) {
        const from = orderedIds.indexOf(lastSelectedId);
        const to = orderedIds.indexOf(rowId);
        const [start, end] = from < to ? [from, to] : [to, from];
        const next = new Set(current);
        orderedIds.slice(start, end + 1).forEach((id) => next.add(id));
        return next;
      }
      if (event.ctrlKey || event.metaKey) {
        const next = new Set(current);
        if (next.has(rowId)) next.delete(rowId);
        else next.add(rowId);
        return next;
      }
      return new Set([rowId]);
    });
    setLastSelectedId(rowId);
  };
  return { selectedRows, selectionRows, cellBlockRange, extendCellBlockSelectionByKeyboard, selectionRowCount, selectRow, startCellBlockSelection, extendCellBlockSelection, selectedIds, setSelectedIds, cellBlockSelection, setCellBlockSelection, lastSelectedId, setLastSelectedId, activeCell, setActiveCell };
}

export type GridSelection = ReturnType<typeof useGridSelection>;
