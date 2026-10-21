import { useCallback, useEffect, useMemo } from "react";
import { type SqlEditorHandle, type SqlEditorRunContext } from "../SqlEditorPanel";
import { registerQueryTab } from "../../../lib/queryRegistry";
import { type PanelState, type SqlStatementSourceRef } from "./types";
import { newPanel } from "./queryModel";


export interface UseDatabaseQueryBridgeContext {
  panels: PanelState[];
  tabLimit: number;
  setPanels: import("react").Dispatch<import("react").SetStateAction<PanelState[]>>;
  setActivePanelId: import("react").Dispatch<import("react").SetStateAction<string>>;
  runQuery: (panelId: string, sqlText: string, options?: { context?: SqlEditorRunContext; origin?: SqlStatementSourceRef["origin"]; historyId?: string; parentSheetId?: string; sheetTitle?: string; }) => Promise<void>;
  activePanelId: string;
  editorHandles: import("react").RefObject<Record<string, SqlEditorHandle | null>>;
  patchPanel: (id: string, patch: Partial<PanelState>) => void;
  panelsRef: import("react").RefObject<PanelState[]>;
  echoPanelIdRef: import("react").RefObject<string | null>;
  activePanelIdRef: import("react").RefObject<string>;
  info: import("../../../types").DbConnectInfo;
  tabId: string;
  flushWorkspace: () => Promise<void>;
}

export function useDatabaseQueryBridge(context: UseDatabaseQueryBridgeContext) {
  const {
    panels,
    tabLimit,
    setPanels,
    setActivePanelId,
    runQuery,
    activePanelId,
    editorHandles,
    patchPanel,
    panelsRef,
    echoPanelIdRef,
    activePanelIdRef,
    info,
    tabId,
    flushWorkspace,
  } = context;

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
      if (options?.destination === "new" && panels.length < tabLimit) {
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
    [activePanelId, panels, patchPanel, runQuery, tabLimit],
  );

  // Append a statement echoed from an AI/Claude Code SQL execution to a stable
  // "echo target" panel — never runs it. The whole chat session's SQL
  // accumulates in one editor (reusing the remembered panel, else the active
  // panel, else a fresh one when the tab has none).
  const appendEchoSqlFromOutside = useCallback((sql: string, note?: string) => {
    const cleaned = sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!cleaned) return;
    // Each statement ends with exactly one semicolon; prepend the comment note.
    const stmt = `${cleaned.replace(/;+\s*$/, "")};`;
    const block = note ? `${note}\n${stmt}` : stmt;

    const livePanels = panelsRef.current;
    const remembered =
      echoPanelIdRef.current && livePanels.some((p) => p.id === echoPanelIdRef.current)
        ? echoPanelIdRef.current
        : null;
    const activeId = activePanelIdRef.current;
    const targetId =
      remembered ??
      (livePanels.some((p) => p.id === activeId) ? activeId : livePanels[0]?.id ?? null);

    if (!targetId) {
      // Tab has no panel yet → open one seeded with the statement.
      const panel = newPanel({ doc: block, dirty: true });
      echoPanelIdRef.current = panel.id;
      setPanels((prev) => {
        const next = [...prev, panel].slice(-tabLimit);
        panelsRef.current = next;
        return next;
      });
      setActivePanelId(panel.id);
      return;
    }

    echoPanelIdRef.current = targetId;
    const editor = editorHandles.current[targetId];
    const current = editor?.getValue() ?? livePanels.find((p) => p.id === targetId)?.doc ?? "";
    const joined = current.trim() ? `${current.replace(/\n+$/, "")}\n\n${block}` : block;
    // `editor` is only live for the mounted (active) panel; for others the doc
    // patch is enough — the editor picks it up when that panel mounts.
    editor?.setValue(joined);
    panelsRef.current = livePanels.map((p) =>
      p.id === targetId ? { ...p, doc: joined, dirty: true } : p
    );
    patchPanel(targetId, { doc: joined, dirty: true });
    setActivePanelId(targetId);
    editor?.focus();
  }, [patchPanel, tabLimit]);

  const queryRegistryTitle = useMemo(() => {
    const database = info.engine === "Presto"
      ? [info.catalog, info.database].filter(Boolean).join(".")
      : info.database;
    return `${info.engine} ${info.host}:${info.port}${database ? `/${database}` : ""}`;
  }, [info.catalog, info.database, info.engine, info.host, info.port]);

  useEffect(() => {
    return registerQueryTab({
      tabId,
      title: queryRegistryTitle,
      engine: info.engine,
      insertQuery: insertQueryFromOutside,
      appendEchoSql: appendEchoSqlFromOutside,
      flushWorkspace,
    });
  }, [appendEchoSqlFromOutside, flushWorkspace, info.engine, insertQueryFromOutside, queryRegistryTitle, tabId]);
  return { insertQueryFromOutside };
}
