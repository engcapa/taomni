import { type PaneSide } from "../../../stores/sftpStore";
import { type ColWidths } from "./types";

export const CROSS_PANE_DRAG_MIME = "taomni/sftp-files";

export const DEFAULT_COL_WIDTHS: ColWidths = { name: 280, size: 80, mtime: 150, type: 90 };

export const MIN_COL_WIDTH = 40;

export const MAX_COL_WIDTH = 800;

export const COL_KEY_PREFIX = "taomni.sftp.cols.";

export function loadColWidths(side: PaneSide): ColWidths {
  try {
    const raw = localStorage.getItem(COL_KEY_PREFIX + side);
    if (!raw) return DEFAULT_COL_WIDTHS;
    const parsed = JSON.parse(raw) as Partial<ColWidths>;
    return {
      name: clampCol(parsed.name ?? DEFAULT_COL_WIDTHS.name),
      size: clampCol(parsed.size ?? DEFAULT_COL_WIDTHS.size),
      mtime: clampCol(parsed.mtime ?? DEFAULT_COL_WIDTHS.mtime),
      type: clampCol(parsed.type ?? DEFAULT_COL_WIDTHS.type),
    };
  } catch {
    return DEFAULT_COL_WIDTHS;
  }
}

export function saveColWidths(side: PaneSide, widths: ColWidths): void {
  try {
    localStorage.setItem(COL_KEY_PREFIX + side, JSON.stringify(widths));
  } catch {
    /* noop */
  }
}

export function clampCol(n: number): number {
  if (!Number.isFinite(n)) return MIN_COL_WIDTH;
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(n)));
}
