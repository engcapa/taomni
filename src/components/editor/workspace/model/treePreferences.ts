import { DEFAULT_CODE_VIEW_PROFILE } from "../../../../lib/codeViewProfile";
import { type TreeViewMode } from "./types";

export const TREE_FONT_SIZE_KEY = "taomni.codeWorkspace.treeFontSize.v1";

export const TREE_VIEW_MODE_KEY = "taomni.codeWorkspace.treeViewMode.v1";

export const FLAT_VIEW_MAX_FILES = 2_000;

export const FLAT_VIEW_MAX_DEPTH = 25;

export const NAV_HISTORY_LIMIT = 100;

export const RECENT_FILES_LIMIT = 50;

export const CODE_WORKSPACE_MIN_FONT_SIZE = 8;

export const CODE_WORKSPACE_MAX_FONT_SIZE = 32;

export const CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE = 12;

export const CODE_WORKSPACE_MIN_TREE_FONT_SIZE = 10;

export const CODE_WORKSPACE_MAX_TREE_FONT_SIZE = 20;

export function clampCodeWorkspaceFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_CODE_VIEW_PROFILE.fontSize;
  return Math.min(CODE_WORKSPACE_MAX_FONT_SIZE, Math.max(CODE_WORKSPACE_MIN_FONT_SIZE, Math.round(size)));
}

export function clampCodeWorkspaceTreeFontSize(size: number): number {
  if (!Number.isFinite(size)) return CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE;
  return Math.min(CODE_WORKSPACE_MAX_TREE_FONT_SIZE, Math.max(CODE_WORKSPACE_MIN_TREE_FONT_SIZE, Math.round(size)));
}

export function readCodeWorkspaceTreeFontSize(): number {
  try {
    const raw = window.localStorage.getItem(TREE_FONT_SIZE_KEY);
    return raw ? clampCodeWorkspaceTreeFontSize(Number(raw)) : CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE;
  } catch {
    return CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE;
  }
}

export function writeCodeWorkspaceTreeFontSize(size: number): void {
  try {
    window.localStorage.setItem(TREE_FONT_SIZE_KEY, String(clampCodeWorkspaceTreeFontSize(size)));
  } catch {
    // Ignore storage failures.
  }
}

export function readCodeWorkspaceTreeViewMode(): TreeViewMode {
  try {
    const raw = window.localStorage.getItem(TREE_VIEW_MODE_KEY);
    return raw === "compact" || raw === "flat" || raw === "tree" || raw === "files" ? raw : "tree";
  } catch {
    return "tree";
  }
}

export function writeCodeWorkspaceTreeViewMode(mode: TreeViewMode): void {
  try {
    window.localStorage.setItem(TREE_VIEW_MODE_KEY, mode);
  } catch {
    // Ignore storage failures.
  }
}
