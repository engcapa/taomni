import { effectiveFileType, formatBytes, type FileEntry } from "../../lib/sftp";

export const EXPLORER_COLUMNS = ["name", "mtime", "type", "size"] as const;
export type ExplorerColumn = typeof EXPLORER_COLUMNS[number];
export type ExplorerColumnWidths = Partial<Record<ExplorerColumn, number>>;
export type ExplorerLabel = (zh: string, en: string) => string;
export const DEFAULT_EXPLORER_WIDTHS = { name: 260, mtime: 140, type: 96, size: 80 };
export const MIN_EXPLORER_WIDTHS = { name: 140, mtime: 100, type: 72, size: 64 };
export const MAX_EXPLORER_COLUMN_WIDTH = 2048;

export function clampExplorerColumn(key: ExplorerColumn, width: number): number {
  return Math.round(Math.max(MIN_EXPLORER_WIDTHS[key], Math.min(MAX_EXPLORER_COLUMN_WIDTH, width)));
}

export function readExplorerColumns(raw: unknown): ExplorerColumnWidths {
  const widths: ExplorerColumnWidths = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return widths;
  for (const key of EXPLORER_COLUMNS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) widths[key] = clampExplorerColumn(key, value);
  }
  return widths;
}

export function explorerColumnLayout(widths: ExplorerColumnWidths) {
  const fixed = { ...DEFAULT_EXPLORER_WIDTHS, ...widths };
  return {
    template: EXPLORER_COLUMNS.map(key => key === "name" && widths.name === undefined ? `minmax(${MIN_EXPLORER_WIDTHS.name}px, 1fr)` : `${fixed[key]}px`).join(" "),
    minWidth: EXPLORER_COLUMNS.reduce((sum, key) => sum + (key === "name" && widths.name === undefined ? MIN_EXPLORER_WIDTHS.name : fixed[key]), 8),
  };
}

export function explorerColumnTitle(key: ExplorerColumn, label: ExplorerLabel): string {
  return { name: label("名称", "Name"), mtime: label("修改日期", "Date modified"), type: label("类型", "Type"), size: label("大小", "Size") }[key];
}

const modifiedDate = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export function explorerColumnText(entry: FileEntry, key: ExplorerColumn, label: ExplorerLabel): string {
  const directory = effectiveFileType(entry) === "dir";
  switch (key) {
    case "name": return entry.name;
    case "mtime": {
      if (!entry.mtime) return "";
      const date = new Date(entry.mtime * 1000);
      return Number.isFinite(date.getTime()) ? modifiedDate.format(date) : date.toString();
    }
    case "type": return directory ? label("文件夹", "File folder") : entry.name.includes(".") ? entry.name.split(".").at(-1)!.toUpperCase() : label("文件", "File");
    case "size": return directory ? "" : formatBytes(entry.size);
  }
}

/** Measure the directory data, including rows outside the virtual viewport. */
export function fitExplorerColumn(key: ExplorerColumn, entries: FileEntry[], label: ExplorerLabel, measure: (text: string) => number): number {
  let width = measure(explorerColumnTitle(key, label)) + 34;
  for (const entry of entries) width = Math.max(width, measure(explorerColumnText(entry, key, label)) + (key === "name" ? 48 : 20));
  return clampExplorerColumn(key, width);
}
