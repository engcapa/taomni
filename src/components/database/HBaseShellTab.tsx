import { Crosshair, Loader2, Play, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { type PanelImperativeHandle, type PanelSize } from "react-resizable-panels";
import { AI_ANSWER_LANGUAGES, answerLanguageLabelKey, type AiAnswerLanguage } from "../../lib/ai/answerLanguage";
import { type HBaseTransport } from "../../lib/hbaseCommands";
import { hbaseCompletionSource } from "../../lib/hbaseCompletions";
import { hbaseStatementRangeAt } from "../../lib/hbaseStatements";
import { useT } from "../../lib/i18n";
import { hbaseConnect, hbaseDisconnect } from "../../lib/ipc";
import { registerQueryTab } from "../../lib/queryRegistry";
import { loadResizableLayout } from "../../lib/resizableLayout";
import { useAppStore } from "../../stores/appStore";
import type { HBaseConnectInfo } from "../../types";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";
import { HBaseWorkspaceView } from "./hbase/HBaseWorkspaceView";
import { createRuntimeHBaseSessionId, DEFAULT_ROW_LIMIT } from "./hbase/model";
import { useHBaseExecution } from "./hbase/useHBaseExecution";
import { useHBaseWorkspace } from "./hbase/useHBaseWorkspace";
import { useDbSessionFontSize } from "./useDbSessionFontSize";

interface HBaseShellTabProps {
  tabId: string;
  info: HBaseConnectInfo;
  visible: boolean;
  /** Toggle the per-tab chat drawer bound to this HBase session. */
  chatToggle?: {
    open: boolean;
    onToggle: () => void;
  };
}

export default function HBaseShellTab({ tabId, info, visible, chatToggle }: HBaseShellTabProps) {
  const t = useT();
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const setTabHasNewOutput = useAppStore((s) => s.setTabHasNewOutput);
  const confirmDialog = useConfirmDialog();
  const rootRef = useRef<HTMLDivElement | null>(null);
  useDbSessionFontSize(visible, rootRef);

  const transport: HBaseTransport = (info.connectionMode as HBaseTransport) ?? "rest";

  const [connectionSessionId, setConnectionSessionId] = useState<string | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);
  const workspace = useHBaseWorkspace({
    info,
    setStatusMessage,
  });
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [schemaMap, setSchemaMap] = useState<Record<string, string[]>>({});
  const [showCommands, setShowCommands] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [leftPanelTab, setLeftPanelTab] = useState<"objects" | "queries">("objects");
  const editorMenu = useContextMenu();
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [aiAnswerLanguage, setAiAnswerLanguage] = useState<AiAnswerLanguage>("inherit");
  const queryTriggerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (visible) setHasBeenVisible(true);
  }, [visible]);

  // --- connection lifecycle ---
  useEffect(() => {
    let cancelled = false;
    const runtimeSessionId = createRuntimeHBaseSessionId(info.sessionId);
    setConnectionSessionId(null);
    setConnError(null);
    void hbaseConnect({ ...info, sessionId: runtimeSessionId })
      .then(() => {
        if (cancelled) {
          void hbaseDisconnect(runtimeSessionId).catch(() => undefined);
          return;
        }
        setConnectionSessionId(runtimeSessionId);
      })
      .catch((err) => {
        if (!cancelled) setConnError(String(err));
      });
    return () => {
      cancelled = true;
      void hbaseDisconnect(runtimeSessionId).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.sessionId]);

  const anyRunning = workspace.panels.some((p) => p.sheets.some((s) => s.running));
  useEffect(() => {
    setTabHasNewOutput(tabId, anyRunning && !visible);
  }, [anyRunning, tabId, visible, setTabHasNewOutput]);
  const execution = useHBaseExecution({
    t,
    confirmDialog,
    connectionSessionId,
    workspace,
    setRefreshSignal,
    setStatusMessage,
    info,
    transport,
    aiAnswerLanguage,
    tabId,
  });

  const openEditorContextMenu = (event: ReactMouseEvent) => {
    workspace.setActivePanelId(workspace.activePanel.id);
    const handle = workspace.editorHandles.current[workspace.activePanel.id];
    const doc = handle?.getValue() ?? workspace.activePanel.doc;
    const selection = handle?.getSelectionRange() ?? null;
    const position = selection && selection.from !== selection.to
      ? selection.from
      : handle?.getCursorPosition() ?? doc.length;
    const range = hbaseStatementRangeAt(doc, position);
    const items: MenuItem[] = [
      {
        label: t("dbAi.askAiExplainSyntax"),
        icon: <Sparkles className="w-3.5 h-3.5" />,
        testId: "hbase-context-ai-explain-syntax",
        disabled: !range,
        onClick: () => {
          if (range) void execution.explainCurrentStatement(workspace.activePanel.id);
        },
      },
      {
        label: t("codeWorkspaceAi.answerLanguageMenu"),
        testId: "hbase-context-ai-answer-language",
        children: AI_ANSWER_LANGUAGES.map((lang) => ({
          label: t(answerLanguageLabelKey(lang)),
          testId: `hbase-context-ai-answer-language-${lang}`,
          checked: lang === aiAnswerLanguage,
          onClick: () => setAiAnswerLanguage(lang),
        })),
      },
      { separator: true, label: "" },
      {
        label: "Run all commands",
        icon: <Play className="w-3 h-3" style={{ color: "#62d36f" }} />,
        onClick: () => void execution.runStatements(workspace.activePanel.id, handle?.getValue() ?? workspace.activePanel.doc),
        disabled: !connectionSessionId || panelRunning,
      },
      {
        label: "Run current command",
        icon: <Crosshair className="w-3 h-3" />,
        onClick: () => execution.runCurrentStatement(workspace.activePanel.id),
        disabled: !connectionSessionId || panelRunning,
      },
    ];
    editorMenu.show(event, items);
  };

  const openQuerySave = useCallback(() => {
    setLeftPanelTab("queries");
    setTimeout(() => queryTriggerRef.current?.(), 0);
  }, []);

  useEffect(() => registerQueryTab({
    tabId,
    title: `HBase ${info.host}:${info.port}`,
    engine: "HBaseShell",
    insertQuery: (command, options) => {
      if (options?.destination === "current") {
        workspace.editorHandles.current[workspace.activePanelId]?.setValue(command);
        workspace.patchPanel(workspace.activePanelId, {
          doc: command,
          savedQueryId: null,
          savedQuery: null,
        });
        if (options.run) void execution.runStatements(workspace.activePanelId, command);
        return;
      }
      const panelId = workspace.addPanel(command);
      if (panelId && options?.run) setTimeout(() => void execution.runStatements(panelId, command), 0);
    },
    appendEchoSql: (command, note) => {
      const current = workspace.editorHandles.current[workspace.activePanelId]?.getValue()
        ?? workspace.panelsRef.current.find((panel) => panel.id === workspace.activePanelId)?.doc
        ?? "";
      const prefix = note ? `# ${note}\n` : "";
      const next = `${current}${current.trim() ? "\n" : ""}${prefix}${command}`;
      workspace.editorHandles.current[workspace.activePanelId]?.setValue(next);
      workspace.patchPanel(workspace.activePanelId, {
        doc: next,
        savedQueryId: null,
        savedQuery: null,
      });
    },
    flushWorkspace: workspace.flushSavedQueries,
  }), [workspace.activePanelId, workspace.addPanel, workspace.flushSavedQueries, info.host, info.port, workspace.patchPanel, execution.runStatements, tabId]);

  // --- tree → workspace bridge ---
  const onRunCommand = useCallback((stmt: string) => void execution.runStatements(workspace.activePanelId, stmt), [execution.runStatements, workspace.activePanelId]);
  const onInsert = useCallback(
    (stmt: string, target: "cursor" | "newPanel" = "cursor") => {
      if (target === "newPanel" && workspace.panels.length < workspace.tabLimit) {
        workspace.addPanel(stmt);
        return;
      }
      const editor = workspace.editorHandles.current[workspace.activePanelId];
      if (editor) {
        editor.insertText(`${stmt}\n`);
        editor.focus();
      } else {
        workspace.patchPanel(workspace.activePanelId, { doc: `${workspace.activePanel?.doc ?? ""}${workspace.activePanel?.doc ? "\n" : ""}${stmt}` });
      }
    },
    [workspace.panels.length, workspace.addPanel, workspace.activePanelId, workspace.activePanel, workspace.patchPanel, workspace.tabLimit],
  );

  const onTablesLoaded = useCallback((tables: string[]) => {
    setSchemaMap((prev) => {
      const next: Record<string, string[]> = {};
      for (const tbl of tables) next[tbl] = prev[tbl] ?? [];
      return next;
    });
  }, []);
  const onFamiliesLoaded = useCallback((table: string, families: string[]) => {
    setSchemaMap((prev) => ({ ...prev, [table]: families }));
  }, []);

  const endpoint = useMemo(() => {
    if (info.connectionMode === "native") {
      const q = info.zkQuorum || (info.host ? `${info.host}:${info.port}` : "") || (info.hbaseSitePath ? "hbase-site.xml" : "ZooKeeper");
      const r = info.zkRoot || "/hbase";
      return `ZK: ${q} (${r})${info.namespace ? ` [${info.namespace}]` : ""}`;
    }
    const scheme = info.ssl ? "https" : "http";
    if (info.connectionMode === "thrift") {
      return `Thrift ${scheme}://${info.host}:${info.port}${info.namespace ? ` [${info.namespace}]` : ""}`;
    }
    const path = info.restPath ? `/${info.restPath.replace(/^\/+|\/+$/g, "")}` : "";
    return `${scheme}://${info.host}:${info.port}${path}${info.namespace ? ` [${info.namespace}]` : ""}`;
  }, [info.connectionMode, info.host, info.namespace, info.port, info.restPath, info.ssl, info.zkQuorum, info.zkRoot, info.hbaseSitePath]);

  // RENDER_MAIN_PLACEHOLDER
  const [rowLimit, setRowLimit] = useState(DEFAULT_ROW_LIMIT);

  // HBase shell command/table autocomplete (replaces lang-sql's SQL keywords).
  const completionSources = useMemo(
    () => [hbaseCompletionSource({ transport, schema: schemaMap })],
    [transport, schemaMap],
  );

  const initialLayout = useMemo(
    () => loadResizableLayout(`hbase-shell-${info.sessionId}`, ["sidebar", "workspace"]),
    [info.sessionId],
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    initialLayout && typeof initialLayout.sidebar === "number" ? initialLayout.sidebar === 0 : false,
  );
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const lastVisibleSidebarWidthRef = useRef<number>(
    initialLayout && typeof initialLayout.sidebar === "number" && initialLayout.sidebar > 0 ? initialLayout.sidebar : 20,
  );
  const expandSidebarPanel = () => {
    const nextSize = Math.min(40, Math.max(15, lastVisibleSidebarWidthRef.current));
    sidebarPanelRef.current?.resize(`${nextSize}%`);
    setSidebarCollapsed(false);
  };
  const handleSidebarResize = (size: PanelSize) => {
    const percentage = size.asPercentage;
    if (percentage > 0) lastVisibleSidebarWidthRef.current = percentage;
    setSidebarCollapsed(percentage === 0);
  };

  if (!hasBeenVisible) {
    return (
      <div className="h-full w-full flex items-center justify-center" style={{ background: "var(--taomni-bg)" }}>
        <Loader2 className="w-6 h-6 animate-spin text-[var(--taomni-text-muted)]" />
      </div>
    );
  }

  const panelRunning = workspace.activePanel.sheets.some((s) => s.running);
  const btn = "h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)] disabled:opacity-40";

  return <HBaseWorkspaceView
    rootRef={rootRef}
    chatToggle={chatToggle}
    visible={visible}
    t={t}
    connError={connError}
    sidebarCollapsed={sidebarCollapsed}
    expandSidebarPanel={expandSidebarPanel}
    info={info}
    initialLayout={initialLayout}
    sidebarPanelRef={sidebarPanelRef}
    handleSidebarResize={handleSidebarResize}
    leftPanelTab={leftPanelTab}
    setLeftPanelTab={setLeftPanelTab}
    connectionSessionId={connectionSessionId}
    transport={transport}
    endpoint={endpoint}
    refreshSignal={refreshSignal}
    rowLimit={rowLimit}
    onRunCommand={onRunCommand}
    onInsert={onInsert}
    workspace={workspace}
    setStatusMessage={setStatusMessage}
    onTablesLoaded={onTablesLoaded}
    onFamiliesLoaded={onFamiliesLoaded}
    execution={execution}
    queryTriggerRef={queryTriggerRef}
    btn={btn}
    panelRunning={panelRunning}
    aiAnswerLanguage={aiAnswerLanguage}
    setLangMenuOpen={setLangMenuOpen}
    langMenuOpen={langMenuOpen}
    setAiAnswerLanguage={setAiAnswerLanguage}
    setShowCommands={setShowCommands}
    setShowHistory={setShowHistory}
    openQuerySave={openQuerySave}
    setShowHelp={setShowHelp}
    setRowLimit={setRowLimit}
    showCommands={showCommands}
    showHistory={showHistory}
    openEditorContextMenu={openEditorContextMenu}
    editorMenu={editorMenu}
    completionSources={completionSources}
    showHelp={showHelp}
    confirmDialog={confirmDialog}
  />;
}
