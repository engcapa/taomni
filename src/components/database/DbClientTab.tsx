import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  Play,
  SquareDashedMousePointer,
  Ban,
  Sparkles,
  Clock,
  Plus,
  X,
  Save,
  AlertTriangle,
  Loader2,
  Bot,
  ExternalLink,
  Maximize2,
  Minimize2,
} from "lucide-react";
import type { DbConnectInfo } from "../../types";
import {
  checkFileExists,
  dbConnect,
  dbDisconnect,
  dbExecute,
  dbExecuteStream,
  dbCancel,
  dbDescribeTable,
  readFileBytes,
  selectSaveFilePath,
  temporaryFilePath,
  writeStreamAbort,
  writeStreamAppend,
  writeStreamClose,
  writeStreamOpen,
  type DbColumnDescription,
  type DbQueryResult,
} from "../../lib/ipc";
import { SchemaTree } from "./SchemaTree";
import { SqlEditorPanel, type SqlEditorHandle } from "./SqlEditorPanel";
import {
  QueryResultGrid,
  type QueryGridCommitPayload,
  type QueryRefreshMode,
} from "./QueryResultGrid";
import { formatSql } from "./formatSql";
import { useAppStore } from "../../stores/appStore";
import FloatingToolbar from "../floating-toolbar/FloatingToolbar";
import CaptureToolbar from "../capture/CaptureToolbar";
import {
  FT_BUTTON_STYLE,
  FT_BUTTON_ACTIVE_OVERRIDE,
  FT_ICON_BUTTON_STYLE,
} from "../floating-toolbar/floatingToolbarStyles";
import { captureElementPng, renderElementToCanvas, safeFilePart } from "../../lib/capture";
import { useT } from "../../lib/i18n";
import { registerQueryTab } from "../../lib/queryRegistry";

interface DbClientTabProps {
  tabId: string;
  info: DbConnectInfo;
  visible: boolean;
  onDetach?: () => void;
  onToggleMaximize?: () => void;
  maximized?: boolean;
  chatToggle?: {
    open: boolean;
    onToggle: () => void;
  };
  detachedWindowControls?: {
    onReattach: () => void;
    onToggleOsFullscreen: () => void;
    osFullscreen: boolean;
  };
}

const MAX_HISTORY = 200;
const MAX_PANELS = 4;
const DEFAULT_MAX_RESULT_SHEETS = 50;
const MIN_RESULT_SHEETS = 1;
const MAX_RESULT_SHEETS_LIMIT = 200;
const DEFAULT_ROW_LIMIT = 1000;
const MIN_ROW_LIMIT = 1;
const MAX_ROW_LIMIT = 1_000_000;
const QUERY_WORKSPACE_CACHE_VERSION = 1;
const QUERY_AUTO_SAVE_MS = 5000;

type ResultSubTab = "results" | "messages";

interface ResultSheet {
  id: string;
  title: string;
  sql: string;
  result: DbQueryResult | null;
  error: string | null;
  warnings: string[];
  running: boolean;
  cancelling: boolean;
  elapsedMs: number;
  resultTab: ResultSubTab;
  rowLimit: number;
  createdAt: number;
}

interface PanelState {
  id: string;
  doc: string;
  sheets: ResultSheet[];
  activeSheetId: string | null;
  filePath: string | null;
  fileName: string | null;
  cachePath: string | null;
  dirty: boolean;
}

interface QueryWorkspacePanelCache {
  id: string;
  filePath: string | null;
  fileName: string | null;
  cachePath: string | null;
}

interface QueryWorkspaceCache {
  version: typeof QUERY_WORKSPACE_CACHE_VERSION;
  activePanelId: string | null;
  panels: QueryWorkspacePanelCache[];
}

function widthKey(engine: string): string {
  return `newmob.db.schemaWidth.${engine}`;
}

function settingKey(engine: string, name: string): string {
  return `newmob.db.${engine}.${name}`;
}

function settingDefaultMigrationKey(engine: string, name: string): string {
  return `${settingKey(engine, name)}.defaultsFixed.v1`;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readIntSetting(engine: string, name: string, fallback: number, min: number, max: number): number {
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

function writeIntSetting(engine: string, name: string, value: number): void {
  try {
    localStorage.setItem(settingKey(engine, name), String(value));
  } catch {
    /* ignore */
  }
}

function workspaceKey(sessionId: string): string {
  return `newmob.db.queryWorkspace.v${QUERY_WORKSPACE_CACHE_VERSION}.${sessionId}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function sanitizeFilePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function defaultQueryCacheName(info: DbConnectInfo, ordinal: number): string {
  const database = info.database ? `-${info.database}` : "";
  const stem = sanitizeFilePart(`${info.engine}-${info.host}-${info.port}${database}`) || "query";
  return `${stem}-query-${ordinal}.sql`;
}

function readWorkspaceCache(sessionId: string): QueryWorkspaceCache | null {
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

function writeWorkspaceCache(sessionId: string, panels: PanelState[], activePanelId: string | null): void {
  try {
    const cache: QueryWorkspaceCache = {
      version: QUERY_WORKSPACE_CACHE_VERSION,
      activePanelId,
      panels: panels
        .filter((panel) => panel.filePath || panel.cachePath)
        .map((panel) => ({
          id: panel.id,
          filePath: panel.filePath,
          fileName: panel.fileName,
          cachePath: panel.cachePath,
        })),
    };
    localStorage.setItem(workspaceKey(sessionId), JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

async function readTextFile(path: string): Promise<string> {
  return new TextDecoder().decode(await readFileBytes(path));
}

async function writeTextFile(path: string, text: string): Promise<void> {
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

function quoteIdent(engine: string, ident: string): string {
  if (engine === "PostgreSQL") return `"${ident.replace(/"/g, "\"\"")}"`;
  return `\`${ident.replace(/`/g, "``")}\``;
}

function qualifiedName(engine: string, schema: string | null, table: string): string {
  return schema
    ? `${quoteIdent(engine, schema)}.${quoteIdent(engine, table)}`
    : quoteIdent(engine, table);
}

function schemaSwitchSql(engine: string, schema: string): string {
  if (engine === "PostgreSQL") {
    return `SET search_path TO ${quoteIdent(engine, schema)}`;
  }
  return `USE ${quoteIdent(engine, schema)}`;
}

function unquoteIdent(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`").replace(/]]/g, "]");
  }
  return trimmed;
}

function parseEditableSelectTarget(sql: string): { schema: string | null; table: string } | null {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .trim();
  if (!/^select\b/i.test(cleaned)) return null;
  if (/\b(join|union|group\s+by|having)\b/i.test(cleaned)) return null;
  const ident = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
  const match = cleaned.match(new RegExp(String.raw`\bfrom\s+(${ident})(?:\s*\.\s*(${ident}))?`, "i"));
  if (!match) return null;
  return match[2]
    ? { schema: unquoteIdent(match[1]), table: unquoteIdent(match[2]) }
    : { schema: null, table: unquoteIdent(match[1]) };
}

function sqlLiteral(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function whereForColumns(engine: string, columns: string[], allColumns: string[], values: (string | null)[]): string {
  const clauses = columns.map((column) => {
    const index = allColumns.findIndex((name) => name === column);
    const value = index >= 0 ? values[index] : null;
    const ident = quoteIdent(engine, column);
    return value === null ? `${ident} IS NULL` : `${ident} = ${sqlLiteral(value)}`;
  });
  return clauses.length > 0 ? clauses.join(" AND ") : "1 = 0";
}

function newPanel(patch: Partial<PanelState> = {}): PanelState {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `panel-${Date.now()}-${Math.random()}`,
    doc: "",
    sheets: [],
    activeSheetId: null,
    filePath: null,
    fileName: null,
    cachePath: null,
    dirty: false,
    ...patch,
  };
}

function newResultSheet(sql: string, ordinal: number, rowLimit: number): ResultSheet {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `sheet-${Date.now()}-${Math.random()}`,
    title: `Result ${ordinal}`,
    sql,
    result: emptyQueryResult(),
    error: null,
    warnings: [],
    running: true,
    cancelling: false,
    elapsedMs: 0,
    resultTab: "results",
    rowLimit,
    createdAt: Date.now(),
  };
}

function activeSheet(panel: PanelState): ResultSheet | null {
  return panel.sheets.find((sheet) => sheet.id === panel.activeSheetId) ?? panel.sheets.at(-1) ?? null;
}

function emptyQueryResult(): DbQueryResult {
  return {
    columns: [],
    rows: [],
    rowsAffected: 0,
    durationMs: 0,
    warnings: [],
  };
}

export default function DbClientTab({
  tabId,
  info,
  visible,
  onDetach,
  onToggleMaximize,
  maximized,
  chatToggle,
  detachedWindowControls,
}: DbClientTabProps) {
  const t = useT();
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [panels, setPanels] = useState<PanelState[]>(() => [newPanel()]);
  const [activePanelId, setActivePanelId] = useState<string>(() => panels[0].id);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [rowLimit, setRowLimit] = useState(() =>
    readIntSetting(info.engine, "rowLimit", DEFAULT_ROW_LIMIT, MIN_ROW_LIMIT, MAX_ROW_LIMIT),
  );
  const [maxResultSheets, setMaxResultSheets] = useState(() =>
    readIntSetting(
      info.engine,
      "maxResultSheets",
      DEFAULT_MAX_RESULT_SHEETS,
      MIN_RESULT_SHEETS,
      MAX_RESULT_SHEETS_LIMIT,
    ),
  );
  const [schemas, setSchemas] = useState<string[]>([]);
  const [activeSchema, setActiveSchema] = useState<string | null>(info.database ?? null);
  const [schemaMap, setSchemaMap] = useState<Record<string, string[]>>({});
  const [historyPanelId, setHistoryPanelId] = useState<string | null>(null);
  const historyRef = useRef<Record<string, string[]>>({});
  const editorHandles = useRef<Record<string, SqlEditorHandle | null>>({});
  const timersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const panelsRef = useRef<PanelState[]>(panels);
  const activePanelIdRef = useRef(activePanelId);
  const autoSaveInFlightRef = useRef(false);
  const lastAutoSavedDocRef = useRef<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const setTabHasNewOutput = useAppStore((s) => s.setTabHasNewOutput);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);

  const sessionId = info.sessionId;
  const workspaceSessionId = info.workspaceSessionId ?? info.sessionId;

  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

  useEffect(() => {
    activePanelIdRef.current = activePanelId;
  }, [activePanelId]);

  // Connect on mount, disconnect on unmount.
  useEffect(() => {
    let cancelled = false;
    void dbConnect(info)
      .then(() => {
        if (!cancelled) setConnected(true);
      })
      .catch((err) => {
        if (!cancelled) setConnError(String(err));
      });
    return () => {
      cancelled = true;
      void dbDisconnect(sessionId).catch(() => undefined);
      Object.values(timersRef.current).forEach(clearInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceReady(false);
    const cache = readWorkspaceCache(workspaceSessionId);
    if (!cache || cache.panels.length === 0) {
      setWorkspaceReady(true);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const restored: PanelState[] = [];
      const restoredDocs: Record<string, string> = {};
      for (const [index, entry] of cache.panels.entries()) {
        const path = entry.filePath ?? entry.cachePath;
        if (!path) continue;
        const exists = await checkFileExists(path).catch(() => false);
        if (!exists) continue;
        const doc = await readTextFile(path).catch(() => null);
        if (doc === null) continue;
        restoredDocs[entry.id] = doc;
        restored.push(
          newPanel({
            id: entry.id,
            doc,
            filePath: entry.filePath,
            fileName: entry.filePath ? basename(entry.filePath) : entry.fileName,
            cachePath: entry.filePath ? null : entry.cachePath,
            dirty: !entry.filePath,
          }),
        );
        if (restored.length >= MAX_PANELS) break;
        if (index >= MAX_PANELS - 1) break;
      }
      if (cancelled) return;
      if (restored.length === 0) {
        setWorkspaceReady(true);
        return;
      }
      lastAutoSavedDocRef.current = restoredDocs;
      setPanels(restored);
      setActivePanelId(
        cache.activePanelId && restored.some((panel) => panel.id === cache.activePanelId)
          ? cache.activePanelId
          : restored[0].id,
      );
      setWorkspaceReady(true);
    })().catch((err) => {
      if (!cancelled) {
        setStatusMessage(`Query workspace restore failed: ${String(err)}`);
        setWorkspaceReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [setStatusMessage, workspaceSessionId]);

  useEffect(() => {
    writeIntSetting(info.engine, "rowLimit", rowLimit);
  }, [info.engine, rowLimit]);

  useEffect(() => {
    writeIntSetting(info.engine, "maxResultSheets", maxResultSheets);
  }, [info.engine, maxResultSheets]);

  useEffect(() => {
    if (!workspaceReady) return;
    writeWorkspaceCache(workspaceSessionId, panels, activePanelId);
  }, [activePanelId, panels, workspaceReady, workspaceSessionId]);

  const patchPanel = useCallback((id: string, patch: Partial<PanelState>) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const updatePanel = useCallback((id: string, updater: (panel: PanelState) => PanelState) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? updater(p) : p)));
  }, []);

  const patchSheet = useCallback((panelId: string, sheetId: string, patch: Partial<ResultSheet>) => {
    updatePanel(panelId, (panel) => ({
      ...panel,
      sheets: panel.sheets.map((sheet) => (sheet.id === sheetId ? { ...sheet, ...patch } : sheet)),
    }));
  }, [updatePanel]);

  const updateSheet = useCallback(
    (panelId: string, sheetId: string, updater: (sheet: ResultSheet) => ResultSheet) => {
      updatePanel(panelId, (panel) => ({
        ...panel,
        sheets: panel.sheets.map((sheet) => (sheet.id === sheetId ? updater(sheet) : sheet)),
      }));
    },
    [updatePanel],
  );

  const autoSaveWorkspace = useCallback(async () => {
    if (!workspaceReady || autoSaveInFlightRef.current) return;
    autoSaveInFlightRef.current = true;
    try {
      const currentPanels = panelsRef.current;
      const patches: Record<string, Partial<PanelState>> = {};

      for (const [index, panel] of currentPanels.entries()) {
        const doc = editorHandles.current[panel.id]?.getValue() ?? panel.doc;
        const hasTarget = !!panel.filePath || !!panel.cachePath;
        if (!hasTarget && !doc.trim()) continue;
        if (hasTarget && lastAutoSavedDocRef.current[panel.id] === doc) continue;

        let targetPath = panel.filePath ?? panel.cachePath;
        if (!targetPath) {
          targetPath = await temporaryFilePath(defaultQueryCacheName(info, index + 1));
          patches[panel.id] = { ...patches[panel.id], cachePath: targetPath };
        }

        await writeTextFile(targetPath, doc);
        lastAutoSavedDocRef.current[panel.id] = doc;

        if (panel.filePath) {
          patches[panel.id] = { ...patches[panel.id], dirty: false };
        }
      }

      const patchedIds = Object.keys(patches);
      if (patchedIds.length === 0) return;
      const nextPanels = currentPanels.map((panel) =>
        patches[panel.id] ? { ...panel, ...patches[panel.id] } : panel,
      );
      panelsRef.current = nextPanels;
      setPanels((prev) => prev.map((panel) =>
        patches[panel.id] ? { ...panel, ...patches[panel.id] } : panel,
      ));
      writeWorkspaceCache(workspaceSessionId, nextPanels, activePanelIdRef.current);
    } catch (err) {
      setStatusMessage(`Query auto-save failed: ${String(err)}`);
    } finally {
      autoSaveInFlightRef.current = false;
    }
  }, [info, setStatusMessage, workspaceReady, workspaceSessionId]);

  useEffect(() => {
    const timer = setInterval(() => {
      void autoSaveWorkspace();
    }, QUERY_AUTO_SAVE_MS);
    return () => {
      clearInterval(timer);
      void autoSaveWorkspace();
    };
  }, [autoSaveWorkspace]);

  const anyRunning = panels.some((p) => p.sheets.some((sheet) => sheet.running));
  useEffect(() => {
    setTabHasNewOutput(tabId, anyRunning && !visible);
  }, [anyRunning, visible, tabId, setTabHasNewOutput]);

  const runQuery = useCallback(
    async (panelId: string, sqlText: string) => {
      const trimmed = sqlText.trim();
      if (!trimmed) return;
      const panel = panels.find((p) => p.id === panelId);
      if (panel?.sheets.some((sheet) => sheet.running)) return;
      // Record history (newest first, dedup consecutive).
      const panelHistory = historyRef.current[panelId] ?? [];
      if (panelHistory[0] !== trimmed) {
        historyRef.current[panelId] = [trimmed, ...panelHistory].slice(0, MAX_HISTORY);
      }
      const sheet = newResultSheet(trimmed, (panel?.sheets.length ?? 0) + 1, rowLimit);
      setPanels((prev) =>
        prev.map((p) => {
          if (p.id !== panelId) return p;
          const sheets = [...p.sheets, sheet].slice(-maxResultSheets);
          return {
            ...p,
            sheets,
            activeSheetId: sheet.id,
          };
        }),
      );
      const started = Date.now();
      const timer = setInterval(() => {
        patchSheet(panelId, sheet.id, { elapsedMs: Date.now() - started });
      }, 100);
      timersRef.current[sheet.id] = timer;
      let sawDone = false;
      try {
        await dbExecuteStream(sessionId, trimmed, rowLimit, (event) => {
          if (event.kind === "columns") {
            updateSheet(panelId, sheet.id, (current) => {
              const result = current.result ?? emptyQueryResult();
              return { ...current, result: { ...result, columns: event.columns } };
            });
          } else if (event.kind === "rows") {
            updateSheet(panelId, sheet.id, (current) => {
              const result = current.result ?? emptyQueryResult();
              const remaining = Math.max(0, current.rowLimit - result.rows.length);
              const rows = remaining > 0 ? event.rows.slice(0, remaining) : [];
              return { ...current, result: { ...result, rows: [...result.rows, ...rows] } };
            });
          } else {
            sawDone = true;
            const warnings = event.warnings ?? [];
            updateSheet(panelId, sheet.id, (current) => {
              const result = current.result ?? emptyQueryResult();
              return {
                ...current,
                result: {
                  ...result,
                  rowsAffected: event.rowsAffected,
                  durationMs: event.durationMs,
                  warnings,
                },
                warnings,
                running: false,
                cancelling: false,
                error: null,
                resultTab: warnings.length > 0 ? "messages" : "results",
              };
            });
          }
        });
        if (!sawDone) {
          patchSheet(panelId, sheet.id, { running: false, cancelling: false });
        }
      } catch (err) {
        patchSheet(panelId, sheet.id, {
          running: false,
          cancelling: false,
          error: String(err),
          warnings: [],
          resultTab: "messages",
        });
      } finally {
        if (timersRef.current[sheet.id] === timer) {
          clearInterval(timer);
          delete timersRef.current[sheet.id];
        }
      }
    },
    [maxResultSheets, panels, patchSheet, rowLimit, sessionId, updateSheet],
  );

  const insertQueryFromOutside = useCallback(
    (
      sql: string,
      options?: {
        run?: boolean;
        destination?: "current" | "new";
        position?: "caret" | "first" | "last" | "replaceAll";
      },
    ) => {
      const text = sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (!text.trim()) return;
      if (options?.destination === "new" && panels.length < MAX_PANELS) {
        const panel = newPanel({ doc: text, dirty: true });
        setPanels((prev) => [...prev, panel]);
        setActivePanelId(panel.id);
        if (options.run) {
          void runQuery(panel.id, text);
        }
        return;
      }
      const panelId = activePanelId;
      const editor = editorHandles.current[panelId];
      const current = editor?.getValue() ?? panels.find((p) => p.id === panelId)?.doc ?? "";
      const position = options?.position ?? "replaceAll";
      const next =
        position === "first"
          ? `${text}${current ? `\n${current}` : ""}`
          : position === "last"
            ? `${current}${current ? "\n" : ""}${text}`
            : position === "caret"
              ? null
              : text;
      if (next === null) {
        editor?.insertText(text);
        patchPanel(panelId, { doc: editor?.getValue() ?? `${current}${text}`, dirty: true });
      } else {
        editor?.setValue(next);
        patchPanel(panelId, { doc: next, dirty: true });
      }
      if (options?.run) {
        void runQuery(panelId, next ?? text);
      }
    },
    [activePanelId, panels, patchPanel, runQuery],
  );

  const queryRegistryTitle = useMemo(() => {
    const database = info.database ? `/${info.database}` : "";
    return `${info.engine} ${info.host}:${info.port}${database}`;
  }, [info.database, info.engine, info.host, info.port]);

  useEffect(() => {
    return registerQueryTab({
      tabId,
      title: queryRegistryTitle,
      engine: info.engine,
      insertQuery: insertQueryFromOutside,
    });
  }, [info.engine, insertQueryFromOutside, queryRegistryTitle, tabId]);

  const captureDbFrame = useCallback(async () => {
    if (!rootRef.current) return null;
    return await renderElementToCanvas(rootRef.current);
  }, []);

  const cancelQuery = useCallback((panelId?: string) => {
    setPanels((prev) =>
      prev.map((p) =>
        panelId && p.id !== panelId
          ? p
          : {
              ...p,
              sheets: p.sheets.map((sheet) => (sheet.running ? { ...sheet, cancelling: true } : sheet)),
            },
      ),
    );
    void dbCancel(sessionId).catch(() => undefined);
  }, [sessionId]);

  const refreshSheet = useCallback(
    async (panelId: string, sheetId: string, mode: QueryRefreshMode) => {
      const panel = panels.find((p) => p.id === panelId);
      const sheet = panel?.sheets.find((candidate) => candidate.id === sheetId);
      const trimmed = sheet?.sql.trim() ?? "";
      if (!panel || !sheet || !trimmed) return;
      if (panel.sheets.some((candidate) => candidate.running)) return;

      const effectiveLimit = mode === "currentLimit" ? rowLimit : sheet.rowLimit;
      if (timersRef.current[sheetId]) {
        clearInterval(timersRef.current[sheetId]);
        delete timersRef.current[sheetId];
      }
      patchSheet(panelId, sheetId, {
        result: mode === "clearView" ? emptyQueryResult() : sheet.result ?? emptyQueryResult(),
        error: null,
        warnings: [],
        running: true,
        cancelling: false,
        elapsedMs: 0,
        rowLimit: effectiveLimit,
        resultTab: "results",
      });

      const started = Date.now();
      const timer = setInterval(() => {
        patchSheet(panelId, sheetId, { elapsedMs: Date.now() - started });
      }, 100);
      timersRef.current[sheetId] = timer;
      let sawDone = false;
      try {
        await dbExecuteStream(sessionId, trimmed, effectiveLimit, (event) => {
          if (event.kind === "columns") {
            updateSheet(panelId, sheetId, (current) => {
              const result = current.result ?? emptyQueryResult();
              return { ...current, result: { ...result, columns: event.columns, rows: [] } };
            });
          } else if (event.kind === "rows") {
            updateSheet(panelId, sheetId, (current) => {
              const result = current.result ?? emptyQueryResult();
              const remaining = Math.max(0, current.rowLimit - result.rows.length);
              const rows = remaining > 0 ? event.rows.slice(0, remaining) : [];
              return { ...current, result: { ...result, rows: [...result.rows, ...rows] } };
            });
          } else {
            sawDone = true;
            const warnings = event.warnings ?? [];
            updateSheet(panelId, sheetId, (current) => {
              const result = current.result ?? emptyQueryResult();
              return {
                ...current,
                result: {
                  ...result,
                  rowsAffected: event.rowsAffected,
                  durationMs: event.durationMs,
                  warnings,
                },
                warnings,
                running: false,
                cancelling: false,
                error: null,
                resultTab: warnings.length > 0 ? "messages" : "results",
              };
            });
          }
        });
        if (!sawDone) {
          patchSheet(panelId, sheetId, { running: false, cancelling: false });
        }
      } catch (err) {
        patchSheet(panelId, sheetId, {
          running: false,
          cancelling: false,
          error: String(err),
          warnings: [],
          resultTab: "messages",
        });
      } finally {
        if (timersRef.current[sheetId] === timer) {
          clearInterval(timer);
          delete timersRef.current[sheetId];
        }
      }
    },
    [panels, patchSheet, rowLimit, sessionId, updateSheet],
  );

  const commitGridChanges = useCallback(
    async (panelId: string, sheetId: string, payload: QueryGridCommitPayload) => {
      const panel = panels.find((p) => p.id === panelId);
      const sheet = panel?.sheets.find((candidate) => candidate.id === sheetId);
      if (!panel || !sheet) throw new Error("Result sheet is no longer available.");
      const target = parseEditableSelectTarget(sheet.sql);
      if (!target) {
        throw new Error("Grid write-back supports simple SELECT ... FROM table result sheets only.");
      }
      const schema = target.schema ?? activeSchema;
      const tableName = qualifiedName(info.engine, schema, target.table);
      let described: DbColumnDescription[] = [];
      try {
        described = await dbDescribeTable(sessionId, schema, target.table);
      } catch {
        described = [];
      }
      const resultColumnNames = payload.columns.map((column) => column.name);
      const primaryKeys = described
        .filter((column) => column.primaryKey && resultColumnNames.includes(column.name))
        .map((column) => column.name);
      const whereColumns = primaryKeys.length > 0 ? primaryKeys : resultColumnNames;
      const statements: string[] = [];
      for (const change of payload.changes) {
        if (change.status === "inserted") {
          const cols = resultColumnNames.map((name) => quoteIdent(info.engine, name)).join(", ");
          const values = change.values.map(sqlLiteral).join(", ");
          statements.push(`INSERT INTO ${tableName} (${cols}) VALUES (${values})`);
        } else if (change.status === "updated") {
          if (!change.original) continue;
          const assignments = resultColumnNames
            .map((name, index) =>
              change.values[index] === change.original?.[index]
                ? null
                : `${quoteIdent(info.engine, name)} = ${sqlLiteral(change.values[index])}`,
            )
            .filter((value): value is string => Boolean(value));
          if (assignments.length === 0) continue;
          const where = whereForColumns(info.engine, whereColumns, resultColumnNames, change.original);
          statements.push(`UPDATE ${tableName} SET ${assignments.join(", ")} WHERE ${where}`);
        } else if (change.status === "deleted") {
          if (!change.original) continue;
          const where = whereForColumns(info.engine, whereColumns, resultColumnNames, change.original);
          statements.push(`DELETE FROM ${tableName} WHERE ${where}`);
        }
      }
      if (statements.length === 0) return;
      for (const sql of statements) {
        await dbExecute(sessionId, sql);
      }
      setStatusMessage(
        `Submitted grid changes: ${payload.counts.inserted} added, ${payload.counts.updated} modified, ${payload.counts.deleted} deleted.`,
      );
      await refreshSheet(panelId, sheetId, "clearView");
    },
    [activeSchema, info.engine, panels, refreshSheet, sessionId, setStatusMessage],
  );

  const onSchemaLoaded = useCallback((tables: Map<string, string[]>) => {
    setSchemaMap((prev) => {
      const next = { ...prev };
      for (const [name, cols] of tables) {
        if (!next[name] || cols.length > 0) next[name] = cols;
      }
      return next;
    });
  }, []);

  const onSchemasLoaded = useCallback((names: string[]) => {
    setSchemas(names);
    setActiveSchema((current) => {
      if (current && names.includes(current)) return current;
      if (info.database && names.includes(info.database)) return info.database;
      return names[0] ?? null;
    });
  }, [info.database]);

  const switchSchema = useCallback(
    async (schema: string) => {
      if (!schema || schema === activeSchema) return;
      const panelId = activePanelId;
      const sql = schemaSwitchSql(info.engine, schema);
      const panel = panels.find((p) => p.id === panelId);
      const sheet = newResultSheet(sql, (panel?.sheets.length ?? 0) + 1, rowLimit);
      sheet.title = "Schema";
      try {
        const result = await dbExecute(sessionId, sql);
        setActiveSchema(schema);
        setPanels((prev) =>
          prev.map((p) =>
            p.id === panelId
              ? {
                  ...p,
                  sheets: [
                    ...p.sheets,
                    {
                      ...sheet,
                      result,
                      warnings: result.warnings,
                      running: false,
                      resultTab: (result.warnings.length > 0 ? "messages" : "results") as ResultSubTab,
                    },
                  ].slice(-maxResultSheets),
                  activeSheetId: sheet.id,
                }
              : p,
          ),
        );
      } catch (err) {
        setPanels((prev) =>
          prev.map((p) =>
            p.id === panelId
              ? {
                  ...p,
                  sheets: [
                    ...p.sheets,
                    {
                      ...sheet,
                      result: null,
                      running: false,
                      error: String(err),
                      warnings: [],
                      resultTab: "messages" as ResultSubTab,
                    },
                  ].slice(-maxResultSheets),
                  activeSheetId: sheet.id,
                }
              : p,
          ),
        );
      }
    },
    [activePanelId, activeSchema, info.engine, maxResultSheets, panels, rowLimit, sessionId],
  );
  const insertIntoActive = useCallback(
    (text: string) => {
      editorHandles.current[activePanelId]?.insertText(text);
    },
    [activePanelId],
  );

  const quickSelect = useCallback(
    (schema: string | null, table: string) => {
      const qualified = qualifiedName(info.engine, schema ?? activeSchema, table);
      const sql = `SELECT * FROM ${qualified} LIMIT ${rowLimit}`;
      editorHandles.current[activePanelId]?.setValue(sql);
      void runQuery(activePanelId, sql);
    },
    [activePanelId, activeSchema, info.engine, rowLimit, runQuery],
  );

  const addPanel = () => {
    if (panels.length >= MAX_PANELS) return;
    const p = newPanel();
    setPanels((prev) => [...prev, p]);
    setActivePanelId(p.id);
  };

  const closePanel = (id: string) => {
    const closing = panels.find((p) => p.id === id);
    if (closing?.sheets.some((sheet) => sheet.running)) {
      void dbCancel(sessionId).catch(() => undefined);
    }
    closing?.sheets.forEach((sheet) => {
      if (timersRef.current[sheet.id]) {
        clearInterval(timersRef.current[sheet.id]);
        delete timersRef.current[sheet.id];
      }
    });
    setPanels((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((p) => p.id !== id);
      if (activePanelId === id) setActivePanelId(next[0].id);
      return next;
    });
    delete editorHandles.current[id];
    delete historyRef.current[id];
    delete lastAutoSavedDocRef.current[id];
  };

  const closeResultSheet = (panelId: string, sheetId: string) => {
    const sheet = panels.find((p) => p.id === panelId)?.sheets.find((s) => s.id === sheetId);
    if (sheet?.running) {
      void dbCancel(sessionId).catch(() => undefined);
    }
    if (timersRef.current[sheetId]) {
      clearInterval(timersRef.current[sheetId]);
      delete timersRef.current[sheetId];
    }
    setPanels((prev) =>
      prev.map((panel) => {
        if (panel.id !== panelId) return panel;
        const sheets = panel.sheets.filter((s) => s.id !== sheetId);
        return {
          ...panel,
          sheets,
          activeSheetId:
            panel.activeSheetId === sheetId ? sheets.at(-1)?.id ?? null : panel.activeSheetId,
        };
      }),
    );
  };

  const showPanelError = (panelId: string, message: string) => {
    const panel = panels.find((p) => p.id === panelId);
    const sheet = newResultSheet("", (panel?.sheets.length ?? 0) + 1, rowLimit);
    sheet.title = "Message";
    setPanels((prev) =>
      prev.map((p) =>
        p.id === panelId
          ? {
              ...p,
              sheets: [
                ...p.sheets,
                { ...sheet, running: false, result: null, error: message, resultTab: "messages" as ResultSubTab },
              ].slice(-maxResultSheets),
              activeSheetId: sheet.id,
            }
          : p,
      ),
    );
  };

  const saveQueryFile = async (panel: PanelState) => {
    const sql = editorHandles.current[panel.id]?.getValue() ?? panel.doc;
    const defaultName = panel.fileName ?? `query-${Date.now()}.sql`;
    const path = await selectSaveFilePath(defaultName, panel.filePath ?? undefined);
    if (!path) return;
    try {
      await writeTextFile(path, sql);
      lastAutoSavedDocRef.current[panel.id] = sql;
      patchPanel(panel.id, {
        filePath: path,
        fileName: basename(path) || defaultName,
        cachePath: null,
        dirty: false,
      });
      writeWorkspaceCache(
        workspaceSessionId,
        panels.map((candidate) =>
          candidate.id === panel.id
            ? { ...candidate, filePath: path, fileName: basename(path) || defaultName, cachePath: null, dirty: false }
            : candidate,
        ),
        activePanelId,
      );
    } catch (err) {
      showPanelError(panel.id, String(err));
    }
  };

  const initialWidth = useMemo(() => {
    try {
      const v = Number(localStorage.getItem(widthKey(info.engine)));
      return Number.isFinite(v) && v >= 12 && v <= 50 ? v : 24;
    } catch {
      return 24;
    }
  }, [info.engine]);

  if (connError) {
    return (
      <div className="h-full w-full flex items-center justify-center p-6" style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}>
        <div className="max-w-md text-center">
          <AlertTriangle className="w-6 h-6 mx-auto mb-2" style={{ color: "#d9534f" }} />
          <div className="font-semibold mb-1">Connection failed</div>
          <div className="text-[12px] text-[var(--moba-text-muted)] break-words">{connError}</div>
        </div>
      </div>
    );
  }

  if (!workspaceReady) {
    return (
      <div
        className="h-full w-full flex items-center justify-center text-sm"
        style={{ background: "var(--moba-bg)", color: "var(--moba-text-muted)" }}
      >
        Loading query workspace...
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="h-full w-full flex flex-col relative"
      style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}
    >
      <FloatingToolbar
        storageKey={`mob.db.toolbar.${info.engine}`}
        defaultTop={4}
        defaultRight={4}
        testId="db-floating-toolbar"
      >
        <CaptureToolbar
          filenamePrefix={safeFilePart(`db-${info.engine}-${info.host}`)}
          getVisible={async () => {
            if (!rootRef.current) throw new Error("Database view not ready");
            return await captureElementPng(rootRef.current);
          }}
          getFull={async () => {
            if (!rootRef.current) throw new Error("Database view not ready");
            return await captureElementPng(rootRef.current);
          }}
          getScrollFrame={captureDbFrame}
          getGifFrame={captureDbFrame}
          onStatus={setStatusMessage}
          compact
        />
        {chatToggle && (
          <button
            type="button"
            data-testid="db-chat-toggle"
            onClick={chatToggle.onToggle}
            title={chatToggle.open ? t("terminal.chatFloatingTitleClose") : t("terminal.chatFloatingTitleOpen")}
            aria-label={chatToggle.open ? t("terminal.chatFloatingLabelClose") : t("terminal.chatFloatingLabelOpen")}
            style={{
              ...FT_ICON_BUTTON_STYLE,
              ...(chatToggle.open ? FT_BUTTON_ACTIVE_OVERRIDE : {}),
            }}
          >
            <Bot size={14} />
          </button>
        )}
        {onDetach && (
          <button
            type="button"
            data-testid="db-detach"
            onClick={onDetach}
            title={t("rdp.detach")}
            aria-label={t("rdp.detach")}
            style={FT_ICON_BUTTON_STYLE}
          >
            <ExternalLink size={14} />
          </button>
        )}
        {onToggleMaximize && (
          <button
            type="button"
            data-testid="db-maximize"
            onClick={onToggleMaximize}
            title={maximized ? t("rdp.restore") : t("rdp.maximize")}
            aria-label={maximized ? t("rdp.restore") : t("rdp.maximize")}
            style={FT_ICON_BUTTON_STYLE}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        )}
        {detachedWindowControls && (
          <>
            <button
              type="button"
              data-testid="detached-reattach"
              onClick={detachedWindowControls.onReattach}
              title={t("rdp.reattach")}
              aria-label={t("rdp.reattach")}
              style={FT_BUTTON_STYLE}
            >
              <ExternalLink size={14} />
              <span>{t("rdp.reattach")}</span>
            </button>
            <button
              type="button"
              data-testid="detached-os-fullscreen"
              onClick={detachedWindowControls.onToggleOsFullscreen}
              title={t("rdp.osFullscreen")}
              aria-label={t("rdp.osFullscreen")}
              style={FT_ICON_BUTTON_STYLE}
            >
              {detachedWindowControls.osFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </>
        )}
      </FloatingToolbar>
      <PanelGroup direction="horizontal" autoSaveId={`db-client-${info.engine}`} className="flex-1 min-h-0">
        <Panel
          defaultSize={initialWidth}
          minSize={12}
          maxSize={50}
          onResize={(size) => {
            try {
              localStorage.setItem(widthKey(info.engine), String(size));
            } catch {
              /* ignore */
            }
          }}
        >
          <div className="h-full" style={{ borderRight: "1px solid var(--moba-divider)" }}>
            {connected && (
              <SchemaTree
                sessionId={sessionId}
                engine={info.engine}
                onInsertTable={insertIntoActive}
                onQuickSelect={quickSelect}
                quickSelectLimit={rowLimit}
                onSchemasLoaded={onSchemasLoaded}
                onSchemaLoaded={onSchemaLoaded}
              />
            )}
          </div>
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-col-resize" />
        <Panel>
          {/* Panel tab strip */}
          <div className="h-full flex flex-col min-w-0">
            <div
              className="h-7 shrink-0 flex items-center gap-1 px-1 text-[11px]"
              style={{ background: "var(--moba-chrome-bg)", borderBottom: "1px solid var(--moba-divider)" }}
            >
              {panels.map((p, i) => {
                const panelRunning = p.sheets.some((sheet) => sheet.running);
                const label = p.fileName ?? `Query ${i + 1}`;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="px-2 h-5 max-w-[190px] rounded inline-flex items-center gap-1"
                    style={{
                      background: p.id === activePanelId ? "var(--moba-selected)" : "transparent",
                      color: p.id === activePanelId ? "var(--moba-accent)" : "var(--moba-text-muted)",
                    }}
                    onClick={() => setActivePanelId(p.id)}
                    title={p.filePath ?? label}
                  >
                    <span className="truncate">{label}{p.dirty ? "*" : ""}</span>
                    {panelRunning && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                    {panels.length > 1 && (
                      <X
                        className="w-3 h-3 shrink-0 hover:text-[var(--moba-text)]"
                        onClick={(e) => {
                          e.stopPropagation();
                          closePanel(p.id);
                        }}
                      />
                    )}
                  </button>
                );
              })}
              {panels.length < MAX_PANELS && (
                <button
                  type="button"
                  title="New query panel"
                  className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--moba-hover)]"
                  onClick={addPanel}
                >
                  <Plus className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Query panels are visible side-by-side so multiple independent
                editors can run and compare results in the same tab. */}
            <PanelGroup direction="horizontal" className="flex-1 min-h-0">
              {panels.map((panel, index) => (
                <Fragment key={panel.id}>
                  <Panel minSize={18}>
                    <div
                      className="h-full flex flex-col min-w-0 relative"
                      data-active={panel.id === activePanelId || undefined}
                      onMouseDown={() => setActivePanelId(panel.id)}
                      style={{
                        borderLeft: panel.id === activePanelId ? "1px solid var(--moba-accent)" : undefined,
                      }}
                    >
                      <EditorToolbar
                        engine={info.engine}
                        schemas={schemas}
                        activeSchema={activeSchema}
                        running={panel.sheets.some((sheet) => sheet.running)}
                        onRun={() => runQuery(panel.id, editorHandles.current[panel.id]?.getValue() ?? "")}
                        onRunSelection={() =>
                          runQuery(panel.id, editorHandles.current[panel.id]?.getSelectionOrAll() ?? "")
                        }
                        onCancel={() => cancelQuery(panel.id)}
                        onFormat={() => {
                          const h = editorHandles.current[panel.id];
                          if (h) h.setValue(formatSql(h.getValue()));
                        }}
                        onToggleHistory={() =>
                          setHistoryPanelId((current) => (current === panel.id ? null : panel.id))
                        }
                        onSave={() => void saveQueryFile(panel)}
                        onSchemaChange={(schema) => void switchSchema(schema)}
                        rowLimit={rowLimit}
                        maxResultSheets={maxResultSheets}
                        onRowLimitChange={(value) =>
                          setRowLimit(clampInt(value, MIN_ROW_LIMIT, MAX_ROW_LIMIT))
                        }
                        onMaxResultSheetsChange={(value) =>
                          setMaxResultSheets(clampInt(value, MIN_RESULT_SHEETS, MAX_RESULT_SHEETS_LIMIT))
                        }
                      />
                      {historyPanelId === panel.id && (
                        <HistoryDropdown
                          history={historyRef.current[panel.id] ?? []}
                          onPick={(sql) => {
                            editorHandles.current[panel.id]?.setValue(sql);
                            setHistoryPanelId(null);
                          }}
                          onClose={() => setHistoryPanelId(null)}
                        />
                      )}
                      <PanelGroup direction="vertical" className="flex-1 min-h-0">
                        <Panel defaultSize={45} minSize={15}>
                          <SqlEditorPanel
                            engine={info.engine}
                            initialDoc={panel.doc}
                            schema={schemaMap}
                            handleRef={(h) => {
                              editorHandles.current[panel.id] = h;
                            }}
                            onDocChange={(doc) => patchPanel(panel.id, { doc, dirty: true })}
                            onFocus={() => setActivePanelId(panel.id)}
                            onRun={(sql) => runQuery(panel.id, sql)}
                          />
                        </Panel>
                        <PanelResizeHandle className="h-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-row-resize" />
                        <Panel minSize={15}>
                          <ResultArea
                            panel={panel}
                            onSheetSelect={(sheetId) => patchPanel(panel.id, { activeSheetId: sheetId })}
                            onSheetClose={(sheetId) => closeResultSheet(panel.id, sheetId)}
                            onTabChange={(sheetId, tab) => patchSheet(panel.id, sheetId, { resultTab: tab })}
                            onRefreshSheet={(sheetId, mode) => void refreshSheet(panel.id, sheetId, mode)}
                            onCommitGridChanges={(sheetId, payload) => commitGridChanges(panel.id, sheetId, payload)}
                            onCancel={() => cancelQuery(panel.id)}
                            onStatus={setStatusMessage}
                          />
                        </Panel>
                      </PanelGroup>
                      <StatusBar panel={panel} />
                    </div>
                  </Panel>
                  {index < panels.length - 1 && (
                    <PanelResizeHandle className="w-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-col-resize" />
                  )}
                </Fragment>
              ))}
            </PanelGroup>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

function EditorToolbar({
  engine,
  schemas,
  activeSchema,
  running,
  onRun,
  onRunSelection,
  onCancel,
  onFormat,
  onToggleHistory,
  onSave,
  onSchemaChange,
  rowLimit,
  maxResultSheets,
  onRowLimitChange,
  onMaxResultSheetsChange,
}: {
  engine: string;
  schemas: string[];
  activeSchema: string | null;
  running: boolean;
  onRun: () => void;
  onRunSelection: () => void;
  onCancel: () => void;
  onFormat: () => void;
  onToggleHistory: () => void;
  onSave: () => void;
  onSchemaChange: (schema: string) => void;
  rowLimit: number;
  maxResultSheets: number;
  onRowLimitChange: (value: number) => void;
  onMaxResultSheetsChange: (value: number) => void;
}) {
  const btn = "h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--moba-hover)] disabled:opacity-40";
  const input = "moba-input h-6 w-[68px] text-[11px]";
  return (
    <div
      className="h-8 shrink-0 flex items-center gap-1 px-2"
      style={{ background: "var(--moba-quick-bg)", borderBottom: "1px solid var(--moba-divider)" }}
    >
      <button type="button" className={btn} onClick={onRun} disabled={running} title="Run (F5)">
        <Play className="w-3.5 h-3.5" style={{ color: "#62d36f" }} /> Run
      </button>
      <button type="button" className={btn} onClick={onRunSelection} disabled={running} title="Run selection">
        <SquareDashedMousePointer className="w-3.5 h-3.5" /> Selection
      </button>
      <button type="button" className={btn} onClick={onCancel} disabled={!running} title="Cancel query">
        <Ban className="w-3.5 h-3.5" style={{ color: "#d9534f" }} /> Cancel
      </button>
      <span className="w-px h-4 mx-1" style={{ background: "var(--moba-divider)" }} />
      <button type="button" className={btn} onClick={onFormat} title="Format SQL">
        <Sparkles className="w-3.5 h-3.5" /> Format
      </button>
      <button type="button" className={btn} onClick={onToggleHistory} title="Query history">
        <Clock className="w-3.5 h-3.5" /> History
      </button>
      <button type="button" className={btn} onClick={onSave} title="Save query tab as SQL file">
        <Save className="w-3.5 h-3.5" /> Save
      </button>
      <span className="w-px h-4 mx-1" style={{ background: "var(--moba-divider)" }} />
      <label className="h-6 inline-flex items-center gap-1 text-[11px] text-[var(--moba-text-muted)]">
        Rows
        <input
          className={input}
          type="number"
          min={MIN_ROW_LIMIT}
          max={MAX_ROW_LIMIT}
          value={rowLimit}
          title="Maximum rows returned by each query"
          onChange={(event) => onRowLimitChange(Number(event.target.value))}
        />
      </label>
      <label className="h-6 inline-flex items-center gap-1 text-[11px] text-[var(--moba-text-muted)]">
        Sheets
        <input
          className={input}
          type="number"
          min={MIN_RESULT_SHEETS}
          max={MAX_RESULT_SHEETS_LIMIT}
          value={maxResultSheets}
          title="Maximum open result sheets in this DB tab"
          onChange={(event) => onMaxResultSheetsChange(Number(event.target.value))}
        />
      </label>
      <div className="flex-1" />
      {schemas.length > 0 && (
        <select
          className="moba-input h-6 max-w-[180px] text-[11px]"
          value={activeSchema ?? ""}
          aria-label="Schema"
          title="Schema / database"
          onChange={(event) => onSchemaChange(event.target.value)}
        >
          {schemas.map((schema) => (
            <option key={schema} value={schema}>
              {schema}
            </option>
          ))}
        </select>
      )}
      <span className="text-[10px] text-[var(--moba-text-muted)]">{engine}</span>
    </div>
  );
}

function HistoryDropdown({
  history,
  onPick,
  onClose,
}: {
  history: string[];
  onPick: (sql: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="absolute right-2 top-9 z-50 w-[420px] max-h-[300px] overflow-auto rounded shadow-lg moba-scroll-y"
        style={{ background: "var(--moba-panel-bg)", border: "1px solid var(--moba-divider)" }}
      >
        {history.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-[var(--moba-text-muted)]">No query history yet.</div>
        ) : (
          history.map((sql, i) => (
            <button
              key={i}
              type="button"
              className="block w-full text-left px-3 py-1.5 text-[11px] hover:bg-[var(--moba-hover)] truncate font-mono"
              onClick={() => onPick(sql)}
              title={sql}
            >
              {sql.replace(/\s+/g, " ")}
            </button>
          ))
        )}
      </div>
    </>
  );
}

function ResultArea({
  panel,
  onSheetSelect,
  onSheetClose,
  onTabChange,
  onRefreshSheet,
  onCommitGridChanges,
  onCancel,
  onStatus,
}: {
  panel: PanelState;
  onSheetSelect: (sheetId: string) => void;
  onSheetClose: (sheetId: string) => void;
  onTabChange: (sheetId: string, tab: ResultSubTab) => void;
  onRefreshSheet: (sheetId: string, mode: QueryRefreshMode) => void;
  onCommitGridChanges: (sheetId: string, payload: QueryGridCommitPayload) => Promise<void>;
  onCancel: () => void;
  onStatus: (message: string) => void;
}) {
  const sheet = activeSheet(panel);
  const tab = "h-6 px-3 text-[11px] inline-flex items-center";
  const waitingForFirstResult =
    !!sheet?.running &&
    sheet.result !== null &&
    sheet.result.columns.length === 0 &&
    sheet.result.rows.length === 0;
  return (
    <div className="h-full flex flex-col min-h-0" style={{ background: "var(--moba-bg)" }}>
      <div
        className="h-7 shrink-0 flex items-end gap-1 px-1 overflow-hidden"
        style={{ background: "var(--moba-chrome-bg)", borderBottom: "1px solid var(--moba-divider)" }}
      >
        {panel.sheets.length === 0 ? (
          <span className="px-2 pb-1 text-[11px] text-[var(--moba-text-muted)]">Result sheets</span>
        ) : (
          panel.sheets.map((resultSheet) => {
            const active = resultSheet.id === sheet?.id;
            return (
              <button
                key={resultSheet.id}
                type="button"
                className="h-6 max-w-[170px] px-2 inline-flex items-center gap-1 text-[11px]"
                style={{
                  background: active ? "var(--moba-tab-active)" : "var(--moba-tab-inactive)",
                  color: active ? "var(--moba-accent)" : "var(--moba-text-muted)",
                  border: "1px solid var(--moba-tab-border)",
                  borderBottom: active ? "1px solid var(--moba-tab-active)" : "1px solid var(--moba-divider)",
                  borderTopLeftRadius: 4,
                  borderTopRightRadius: 4,
                }}
                onClick={() => onSheetSelect(resultSheet.id)}
                title={resultSheet.sql}
              >
                <span className="truncate">{resultSheet.title}</span>
                {resultSheet.running && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                {(resultSheet.error || resultSheet.warnings.length > 0) && (
                  <span className="text-[10px] shrink-0">●</span>
                )}
                <X
                  className="w-3 h-3 shrink-0 hover:text-[var(--moba-text)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSheetClose(resultSheet.id);
                  }}
                />
              </button>
            );
          })
        )}
      </div>
      {sheet && (
        <div className="h-7 shrink-0 flex items-center gap-1 px-1" style={{ borderBottom: "1px solid var(--moba-divider)" }}>
          <button
            type="button"
            className={tab}
            style={{ color: sheet.resultTab === "results" ? "var(--moba-accent)" : "var(--moba-text-muted)" }}
            onClick={() => onTabChange(sheet.id, "results")}
          >
            Results
          </button>
          <button
            type="button"
            className={tab}
            style={{ color: sheet.resultTab === "messages" ? "var(--moba-accent)" : "var(--moba-text-muted)" }}
            onClick={() => onTabChange(sheet.id, "messages")}
          >
            Messages{(sheet.error || sheet.warnings.length > 0) ? " ●" : ""}
          </button>
          <span className="ml-auto truncate px-2 text-[10px] text-[var(--moba-text-muted)] font-mono" title={sheet.sql}>
            {sheet.sql.replace(/\s+/g, " ")}
          </span>
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col">
        {!sheet ? (
          <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--moba-text-muted)]">
            Run a query to create a result sheet.
          </div>
        ) : sheet.resultTab === "results" ? (
          waitingForFirstResult ? (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--moba-text-muted)]">
              {sheet.cancelling ? "Cancelling…" : "Running…"}
            </div>
          ) : sheet.result ? (
            <div className={`flex-1 min-h-0 flex flex-col ${sheet.cancelling ? "opacity-50 pointer-events-none" : ""}`}>
              <QueryResultGrid
                result={sheet.result}
                sourceSql={sheet.sql}
                running={sheet.running}
                cancelling={sheet.cancelling}
                onRefresh={(mode) => onRefreshSheet(sheet.id, mode)}
                onCancel={onCancel}
                onCommitChanges={(payload) => onCommitGridChanges(sheet.id, payload)}
                onStatus={onStatus}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--moba-text-muted)]">
              {sheet.running ? "Running…" : "Run a query to see results."}
            </div>
          )
        ) : (
          <div className="flex-1 overflow-auto moba-scroll-y p-2 text-[12px] font-mono">
            {sheet.error && <div style={{ color: "#d9534f" }}>{sheet.error}</div>}
            {sheet.warnings.map((w, i) => (
              <div key={i} style={{ color: "#e6a817" }}>
                {w}
              </div>
            ))}
            {!sheet.error && sheet.warnings.length === 0 && (
              <div className="text-[var(--moba-text-muted)]">No messages.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBar({ panel }: { panel: PanelState }) {
  const sheet = activeSheet(panel);
  const r = sheet?.result ?? null;
  return (
    <div
      className="h-6 shrink-0 flex items-center gap-3 px-2 text-[11px] text-[var(--moba-text-muted)]"
      style={{ background: "var(--moba-quick-bg)", borderTop: "1px solid var(--moba-divider)" }}
    >
      {sheet?.running ? (
        <span className="inline-flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> {sheet.cancelling ? "Cancelling" : "Running"}{" "}
          {(sheet.elapsedMs / 1000).toFixed(1)}s
        </span>
      ) : r ? (
        <>
          {r.columns.length > 0 && <span>{r.rows.length} rows</span>}
          {r.columns.length > 0 && <span>{r.columns.length} cols</span>}
          {r.rowsAffected > 0 && <span>{r.rowsAffected} affected</span>}
          <span>{r.durationMs} ms</span>
          {sheet && <span>limit {sheet.rowLimit}</span>}
        </>
      ) : (
        <span>{panel.sheets.length} result sheet(s)</span>
      )}
    </div>
  );
}
