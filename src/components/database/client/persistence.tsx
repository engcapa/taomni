import { readFileBytes, writeStreamAbort, writeStreamAppend, writeStreamClose, writeStreamOpen } from "../../../lib/ipc";
import { type QueryWorkspaceCache } from "./types";


export const MAX_HISTORY = 200;

export const DEFAULT_ROW_LIMIT = 1000;

export const MIN_ROW_LIMIT = 1;

export const MAX_ROW_LIMIT = 1_000_000;

export const QUERY_WORKSPACE_CACHE_VERSION = 1;

export const QUERY_AUTO_SAVE_MS = 5000;

export const MAX_PANEL_NAME_LENGTH = 120;


export function createRuntimeDbSessionId(baseSessionId: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${baseSessionId}::${suffix}`;
}


export function widthKey(engine: string): string {
  return `taomni.db.schemaWidth.${engine}`;
}


export function settingKey(engine: string, name: string): string {
  return `taomni.db.${engine}.${name}`;
}


export function settingDefaultMigrationKey(engine: string, name: string): string {
  return `${settingKey(engine, name)}.defaultsFixed.v1`;
}


export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}


export function readIntSetting(engine: string, name: string, fallback: number, min: number, max: number): number {
  try {
    const key = settingKey(engine, name);
    const migrationKey = settingDefaultMigrationKey(engine, name);
    const rawValue = localStorage.getItem(key);
    if (rawValue === null || rawValue.trim() === "") {
      localStorage.setItem(migrationKey, "1");
      return fallback;
    }
    const raw = Number(rawValue);
    if (!Number.isFinite(raw)) {
      localStorage.setItem(migrationKey, "1");
      return fallback;
    }
    const clamped = clampInt(raw, min, max);
    const migrated = localStorage.getItem(migrationKey) === "1";
    localStorage.setItem(migrationKey, "1");
    if (!migrated && clamped === min && fallback > min) {
      return fallback;
    }
    return clamped;
  } catch {
    return fallback;
  }
}


export function writeIntSetting(engine: string, name: string, value: number): void {
  try {
    localStorage.setItem(settingKey(engine, name), String(value));
  } catch {
    /* ignore */
  }
}


export function workspaceKey(sessionId: string): string {
  return `taomni.db.queryWorkspace.v${QUERY_WORKSPACE_CACHE_VERSION}.${sessionId}`;
}


export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}


export function readLegacyWorkspaceCache(sessionId: string): QueryWorkspaceCache | null {
  try {
    const raw = localStorage.getItem(workspaceKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QueryWorkspaceCache>;
    if (parsed.version !== QUERY_WORKSPACE_CACHE_VERSION || !Array.isArray(parsed.panels)) {
      return null;
    }
    return {
      version: QUERY_WORKSPACE_CACHE_VERSION,
      activePanelId: typeof parsed.activePanelId === "string" ? parsed.activePanelId : null,
      panels: parsed.panels
        .map((panel) => ({
          id: typeof panel?.id === "string" ? panel.id : "",
          filePath: typeof panel?.filePath === "string" ? panel.filePath : null,
          fileName: typeof panel?.fileName === "string" ? panel.fileName : null,
          cachePath: typeof panel?.cachePath === "string" ? panel.cachePath : null,
        }))
        .filter((panel) => panel.id && (panel.filePath || panel.cachePath)),
    };
  } catch {
    return null;
  }
}


export async function readTextFile(path: string): Promise<string> {
  return new TextDecoder().decode(await readFileBytes(path));
}


export async function writeTextFile(path: string, text: string): Promise<void> {
  let handleId: string | null = null;
  try {
    handleId = await writeStreamOpen(path);
    await writeStreamAppend(handleId, new TextEncoder().encode(text));
    await writeStreamClose(handleId);
  } catch (err) {
    if (handleId) await writeStreamAbort(handleId).catch(() => undefined);
    throw err;
  }
}
