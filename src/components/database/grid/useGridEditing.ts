import { useCallback, useEffect, useState } from "react";
import { confirmAppDialog } from "../../../lib/appDialogs";
import { gridChangeConfirmMessage, type GridChangePreview } from "../../../lib/dbGridChanges";
import { statusAfterValueChange } from "./export";
import { makeRows, nextRowId } from "./model";
import { type GridRow, type QueryGridCommitPayload, type QueryGridRowChange } from "./types";
import type { GridSelection } from "./useGridSelection";


export interface UseGridEditingContext {
  selection: GridSelection;
  setRows: import("react").Dispatch<import("react").SetStateAction<GridRow[]>>;
  rows: GridRow[];
  visibleColumnIndexes: number[];
  setStatus: (message: string) => void;
  result: import("../../../lib/ipc").DbQueryResult;
  changeCounts: { inserted: number; updated: number; deleted: number; };
  onPreviewChanges: ((payload: QueryGridCommitPayload) => Promise<GridChangePreview>) | undefined;
  onCommitChanges: ((payload: QueryGridCommitPayload) => Promise<void>) | undefined;
}

export function useGridEditing(context: UseGridEditingContext) {
  const {
    setRows,
    rows,
    visibleColumnIndexes,
    setStatus,
    result,
    changeCounts,
    onPreviewChanges,
    onCommitChanges,
  } = context;
  const { setActiveCell, activeCell, selectedIds, setSelectedIds, setCellBlockSelection, selectedRows } = context.selection;

  const [editingCell, setEditingCell] = useState<{ rowId: string; colIdx: number; } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [submittingChanges, setSubmittingChanges] = useState(false);


  useEffect(() => setEditingCell(null), [result]);

  const updateCell = (rowId: string, colIdx: number, value: string | null) => {
    setRows((current) =>
      current.map((row) => {
        if (row.id !== rowId || row.status === "deleted") return row;
        const values = [...row.values];
        values[colIdx] = value;
        return { ...row, values, status: statusAfterValueChange(row, values) };
      }),
    );
  };

  const beginEdit = (rowId: string, colIdx: number, currentValue: string | null) => {
    setActiveCell({ rowId, colIdx });
    setEditingCell({ rowId, colIdx });
    setEditValue(currentValue ?? "");
  };

  const commitEdit = () => {
    if (!editingCell) return;
    updateCell(editingCell.rowId, editingCell.colIdx, editValue);
    setEditingCell(null);
  };

  const cancelEdit = () => {
    setEditingCell(null);
    setEditValue("");
  };

  const targetCellPositions = useCallback(() => {
    if (activeCell) {
      const targetIds = selectedIds.size > 0 ? selectedIds : new Set([activeCell.rowId]);
      return rows
        .filter((row) => targetIds.has(row.id) && row.status !== "deleted")
        .map((row) => ({ rowId: row.id, colIdx: activeCell.colIdx }));
    }
    if (selectedIds.size > 0) {
      return rows
        .filter((row) => selectedIds.has(row.id) && row.status !== "deleted")
        .flatMap((row) => visibleColumnIndexes.map((colIdx) => ({ rowId: row.id, colIdx })));
    }
    return [];
  }, [activeCell, rows, selectedIds, visibleColumnIndexes]);

  const applyValueToTargets = (valueFactory: () => string | null) => {
    const targets = targetCellPositions();
    if (targets.length === 0) {
      setStatus("Select a row or cell before applying an edit value.");
      return;
    }
    setRows((current) =>
      current.map((row) => {
        const rowTargets = targets.filter((target) => target.rowId === row.id);
        if (rowTargets.length === 0 || row.status === "deleted") return row;
        const values = [...row.values];
        for (const target of rowTargets) {
          values[target.colIdx] = valueFactory();
        }
        return { ...row, values, status: statusAfterValueChange(row, values) };
      }),
    );
    setStatus(`Edited ${targets.length} cell(s).`);
  };

  const addRow = () => {
    const row: GridRow = {
      id: nextRowId("inserted"),
      originalIndex: null,
      values: result.columns.map(() => null),
      original: null,
      status: "inserted",
    };
    setRows((current) => [...current, row]);
    setSelectedIds(new Set([row.id]));
    setCellBlockSelection(null);
    setActiveCell(result.columns.length > 0 ? { rowId: row.id, colIdx: 0 } : null);
    setStatus("Added a new grid row.");
  };

  const duplicateRows = () => {
    const sources =
      selectedRows.length > 0
        ? selectedRows
        : activeCell
          ? rows.filter((row) => row.id === activeCell.rowId && row.status !== "deleted")
          : [];
    if (sources.length === 0) {
      setStatus("Select at least one row to duplicate.");
      return;
    }
    const copies = sources.map<GridRow>((row) => ({
      id: nextRowId("copy"),
      originalIndex: null,
      values: [...row.values],
      original: null,
      status: "inserted",
    }));
    setRows((current) => [...current, ...copies]);
    setSelectedIds(new Set(copies.map((row) => row.id)));
    setStatus(`Duplicated ${copies.length} row(s).`);
  };

  const deleteRows = () => {
    const targetIds = selectedIds.size > 0 ? selectedIds : activeCell ? new Set([activeCell.rowId]) : new Set<string>();
    if (targetIds.size === 0) {
      setStatus("Select at least one row to delete.");
      return;
    }
    setRows((current) =>
      current
        .filter((row) => !(targetIds.has(row.id) && row.status === "inserted"))
        .map((row) => (targetIds.has(row.id) ? { ...row, status: "deleted" } : row)),
    );
    setSelectedIds(new Set());
    setActiveCell(null);
    setStatus(`Marked ${targetIds.size} row(s) for deletion.`);
  };

  const undoChanges = () => {
    setRows(makeRows(result));
    setSelectedIds(new Set());
    setActiveCell(null);
    setEditingCell(null);
    setStatus("Reverted unsubmitted grid changes.");
  };

  const submitChanges = async () => {
    const changes: QueryGridRowChange[] = rows
      .filter((row) => row.status !== "clean")
      .map((row) => ({
        status: row.status as QueryGridRowChange["status"],
        originalIndex: row.originalIndex,
        values: [...row.values],
        original: row.original ? [...row.original] : null,
      }));
    if (changes.length === 0) return;
    const payload: QueryGridCommitPayload = { columns: result.columns, changes, counts: changeCounts };
    let preview: GridChangePreview | null = null;
    try {
      preview = onPreviewChanges ? await onPreviewChanges(payload) : null;
    } catch {
      // Not previewable (e.g. not a simple SELECT); the submit reports why.
      preview = null;
    }
    const ok = await confirmAppDialog({
      title: "Apply grid changes",
      message: gridChangeConfirmMessage(changeCounts, preview),
      confirmLabel: "Apply",
      danger: changeCounts.deleted > 0,
    });
    if (!ok) {
      setStatus("Grid change submit canceled.");
      return;
    }
    if (!onCommitChanges) {
      setStatus("This result sheet cannot be written back because no editable table metadata is available.");
      return;
    }
    setSubmittingChanges(true);
    try {
      await onCommitChanges(payload);
      const keptRows = rows.filter((row) => row.status !== "deleted");
      setRows(
        keptRows.map((row, index) => ({
          id: `row-${index}-${keptRows.length}`,
          originalIndex: index,
          values: [...row.values],
          original: [...row.values],
          status: "clean",
        })),
      );
      setSelectedIds(new Set());
      setCellBlockSelection(null);
      setActiveCell(null);
      setStatus(`Submitted ${changes.length} grid change(s).`);
    } catch (err) {
      setStatus(`Submit failed: ${String(err)}`);
    } finally {
      setSubmittingChanges(false);
    }
  };
  return { beginEdit, addRow, duplicateRows, deleteRows, applyValueToTargets, submitChanges, undoChanges, commitEdit, cancelEdit, editingCell, setEditingCell, editValue, setEditValue, submittingChanges, setSubmittingChanges };
}
