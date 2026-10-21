import { type Shape } from "./types";

/** Snapshot history: every mutation pushes the previous shape list. */
export interface History {
  shapes: Shape[];
  undo: Shape[][];
  redo: Shape[][];
}

export function commit(h: History, next: Shape[]): History {
  return { shapes: next, undo: [...h.undo, h.shapes], redo: [] };
}

export function undoHistory(h: History): History {
  if (h.undo.length === 0) return h;
  return { shapes: h.undo[h.undo.length - 1], undo: h.undo.slice(0, -1), redo: [...h.redo, h.shapes] };
}

export function redoHistory(h: History): History {
  if (h.redo.length === 0) return h;
  return { shapes: h.redo[h.redo.length - 1], undo: [...h.undo, h.shapes], redo: h.redo.slice(0, -1) };
}

export const EMPTY_HISTORY: History = { shapes: [], undo: [], redo: [] };
