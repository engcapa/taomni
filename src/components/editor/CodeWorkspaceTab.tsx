import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  addCursorAbove,
  addCursorBelow,
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
} from "@codemirror/language";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  X,
} from "lucide-react";
import {
  workspaceListDir,
  workspaceReadFile,
  workspaceWriteFile,
  type WorkspaceEntry,
} from "../../lib/editor/workspace";
import { codeViewExtensions } from "../../lib/codeViewTheme";
import { useAppStore } from "../../stores/appStore";
import { confirmAppDialog } from "../../lib/appDialogs";
import { languageForPath } from "../git/diffLanguage";

interface CodeWorkspaceTabProps {
  tabId: string;
  repoRoot: string;
  initialPath?: string | null;
  visible?: boolean;
}

interface DirectoryState {
  entries: WorkspaceEntry[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

interface OpenFileState {
  path: string;
  text: string;
  savedText: string;
  hash: string;
  mtime: number;
  size: number;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
}

const DEFAULT_DIR_STATE: DirectoryState = {
  entries: [],
  loaded: false,
  loading: false,
  error: null,
};

const WORKSPACE_EDITOR_STYLE = EditorView.theme({
  "&": {
    height: "100%",
  },
  ".cm-foldGutter .cm-gutterElement": {
    minWidth: "1.6ch",
    padding: "0 4px",
  },
});

function repoName(repoRoot: string): string {
  const normalized = repoRoot.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] || normalized || "Workspace";
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatMtime(mtime: number): string {
  if (!mtime) return "";
  try {
    return new Date(mtime * 1000).toLocaleString();
  } catch {
    return "";
  }
}

function shouldHideEntry(entry: WorkspaceEntry): boolean {
  return entry.path === ".git" || entry.path.startsWith(".git/");
}

function makeLoadingFile(path: string): OpenFileState {
  return {
    path,
    text: "",
    savedText: "",
    hash: "",
    mtime: 0,
    size: 0,
    loading: true,
    saving: false,
    dirty: false,
    error: null,
  };
}

export function CodeWorkspaceTab({
  tabId,
  repoRoot,
  initialPath,
  visible = true,
}: CodeWorkspaceTabProps) {
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const setTabCodeWorkspaceContext = useAppStore((s) => s.setTabCodeWorkspaceContext);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [treeFilter, setTreeFilter] = useState("");
  const [openFiles, setOpenFiles] = useState<Record<string, OpenFileState>>({});
  const [openOrder, setOpenOrder] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const openFilesRef = useRef(openFiles);
  const openOrderRef = useRef(openOrder);
  const initialPathRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  useEffect(() => {
    openOrderRef.current = openOrder;
  }, [openOrder]);

  const loadDir = useCallback(
    async (path: string) => {
      setDirectories((current) => ({
        ...current,
        [path]: {
          ...(current[path] ?? DEFAULT_DIR_STATE),
          loading: true,
          error: null,
        },
      }));
      try {
        const entries = await workspaceListDir(repoRoot, path);
        setDirectories((current) => ({
          ...current,
          [path]: {
            entries,
            loaded: true,
            loading: false,
            error: null,
          },
        }));
      } catch (err) {
        const message = errorMessage(err);
        setDirectories((current) => ({
          ...current,
          [path]: {
            ...(current[path] ?? DEFAULT_DIR_STATE),
            loaded: true,
            loading: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [repoRoot, setStatusMessage],
  );

  useEffect(() => {
    setDirectories({});
    setExpanded(new Set([""]));
    setOpenFiles({});
    setOpenOrder([]);
    setActivePath(null);
    initialPathRef.current = undefined;
    void loadDir("");
  }, [loadDir, repoRoot]);

  const openFile = useCallback(
    async (path: string) => {
      setActivePath(path);
      setOpenOrder((current) => (current.includes(path) ? current : [...current, path]));
      if (openFilesRef.current[path] && !openFilesRef.current[path].loading) return;
      setOpenFiles((current) => ({
        ...current,
        [path]: current[path] ?? makeLoadingFile(path),
      }));
      try {
        const file = await workspaceReadFile(repoRoot, path);
        setOpenFiles((current) => ({
          ...current,
          [file.path]: {
            path: file.path,
            text: file.text,
            savedText: file.text,
            hash: file.hash,
            mtime: file.mtime,
            size: file.size,
            loading: false,
            saving: false,
            dirty: false,
            error: null,
          },
        }));
        setStatusMessage(`Opened ${file.path}`);
      } catch (err) {
        const message = errorMessage(err);
        setOpenFiles((current) => ({
          ...current,
          [path]: {
            ...(current[path] ?? makeLoadingFile(path)),
            loading: false,
            saving: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [repoRoot, setStatusMessage],
  );

  useEffect(() => {
    const target = initialPath?.trim();
    if (!target || initialPathRef.current === target) return;
    initialPathRef.current = target;
    void openFile(target);
  }, [initialPath, openFile]);

  const toggleDir = useCallback(
    (path: string) => {
      const wasExpanded = expanded.has(path);
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      const state = directories[path];
      if (!wasExpanded && (!state?.loaded || state.error)) {
        void loadDir(path);
      }
    },
    [directories, expanded, loadDir],
  );

  const refreshTree = useCallback(() => {
    setDirectories({});
    setExpanded(new Set([""]));
    void loadDir("");
  }, [loadDir]);

  const updateFileText = useCallback((path: string, text: string) => {
    setOpenFiles((current) => {
      const file = current[path];
      if (!file || file.text === text) return current;
      return {
        ...current,
        [path]: {
          ...file,
          text,
          dirty: text !== file.savedText,
          error: null,
        },
      };
    });
  }, []);

  const saveFile = useCallback(
    async (path: string | null = activePath) => {
      if (!path) return;
      const file = openFilesRef.current[path];
      if (!file || file.loading || file.saving || !file.dirty) return;
      const textToSave = file.text;
      setOpenFiles((current) => ({
        ...current,
        [path]: { ...current[path], saving: true, error: null },
      }));
      try {
        const saved = await workspaceWriteFile(repoRoot, path, textToSave, file.hash);
        setOpenFiles((current) => {
          const latest = current[saved.path];
          const latestText = latest?.text ?? saved.text;
          const changedWhileSaving = latestText !== textToSave;
          return {
            ...current,
            [saved.path]: {
              path: saved.path,
              text: changedWhileSaving ? latestText : saved.text,
              savedText: saved.text,
              hash: saved.hash,
              mtime: saved.mtime,
              size: saved.size,
              loading: false,
              saving: false,
              dirty: changedWhileSaving,
              error: null,
            },
          };
        });
        setStatusMessage(`Saved ${saved.path}`);
      } catch (err) {
        const message = errorMessage(err);
        setOpenFiles((current) => ({
          ...current,
          [path]: {
            ...current[path],
            saving: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [activePath, repoRoot, setStatusMessage],
  );

  const reloadFile = useCallback(
    async (path: string | null = activePath) => {
      if (!path) return;
      const file = openFilesRef.current[path];
      if (file?.dirty) {
        const confirmed = await confirmAppDialog({
          title: "Reload file",
          message: `Discard unsaved changes in ${path}?`,
          confirmLabel: "Reload",
          danger: true,
        });
        if (!confirmed) return;
      }
      setOpenFiles((current) => ({
        ...current,
        [path]: {
          ...(current[path] ?? makeLoadingFile(path)),
          loading: true,
          error: null,
        },
      }));
      try {
        const reloaded = await workspaceReadFile(repoRoot, path);
        setOpenFiles((current) => ({
          ...current,
          [reloaded.path]: {
            path: reloaded.path,
            text: reloaded.text,
            savedText: reloaded.text,
            hash: reloaded.hash,
            mtime: reloaded.mtime,
            size: reloaded.size,
            loading: false,
            saving: false,
            dirty: false,
            error: null,
          },
        }));
        setStatusMessage(`Reloaded ${reloaded.path}`);
      } catch (err) {
        const message = errorMessage(err);
        setOpenFiles((current) => ({
          ...current,
          [path]: {
            ...(current[path] ?? makeLoadingFile(path)),
            loading: false,
            saving: false,
            error: message,
          },
        }));
        setStatusMessage(message);
      }
    },
    [activePath, repoRoot, setStatusMessage],
  );

  const closeFile = useCallback(
    async (path: string) => {
      const file = openFilesRef.current[path];
      if (file?.dirty) {
        const confirmed = await confirmAppDialog({
          title: "Close file",
          message: `Discard unsaved changes in ${path}?`,
          confirmLabel: "Close",
          danger: true,
        });
        if (!confirmed) return;
      }
      const order = openOrderRef.current;
      const index = order.indexOf(path);
      const nextOrder = order.filter((entry) => entry !== path);
      setOpenOrder(nextOrder);
      setOpenFiles((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      setActivePath((current) => {
        if (current !== path) return current;
        return nextOrder[Math.min(index, nextOrder.length - 1)] ?? null;
      });
    },
    [],
  );

  const activeFile = activePath ? openFiles[activePath] ?? null : null;
  const dirtyCount = useMemo(
    () => Object.values(openFiles).filter((file) => file.dirty).length,
    [openFiles],
  );
  const dirtyPaths = useMemo(
    () => openOrder.filter((path) => openFiles[path]?.dirty),
    [openFiles, openOrder],
  );
  const title = repoName(repoRoot);

  useEffect(() => {
    setTabCodeWorkspaceContext(tabId, {
      repoRoot,
      activePath,
      openPaths: openOrder,
      dirtyPaths,
    });
  }, [activePath, dirtyPaths, openOrder, repoRoot, setTabCodeWorkspaceContext, tabId]);

  useEffect(() => {
    return () => setTabCodeWorkspaceContext(tabId, null);
  }, [setTabCodeWorkspaceContext, tabId]);

  const renderEntries = useCallback(
    (path: string, depth: number): ReactNode => {
      const state = directories[path] ?? DEFAULT_DIR_STATE;
      const filter = treeFilter.trim().toLowerCase();
      if (state.loading && !state.loaded) {
        return (
          <div className="h-7 flex items-center gap-2 px-2 text-[12px] text-[var(--taomni-text-muted)]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Loading</span>
          </div>
        );
      }
      if (state.error) {
        return (
          <div className="m-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-[12px] text-red-500">
            {state.error}
          </div>
        );
      }
      const entries = state.entries.filter((entry) => {
        if (shouldHideEntry(entry)) return false;
        if (!filter) return true;
        return entry.name.toLowerCase().includes(filter) || entry.path.toLowerCase().includes(filter);
      });
      if (entries.length === 0) {
        return (
          <div className="px-3 py-2 text-[12px] text-[var(--taomni-text-muted)]">
            Empty
          </div>
        );
      }
      return entries.map((entry) => {
        const isDir = entry.fileType === "dir";
        const isExpanded = expanded.has(entry.path);
        const rowStyle = { paddingLeft: `${8 + depth * 14}px` };
        if (isDir) {
          const childState = directories[entry.path];
          return (
            <Fragment key={entry.path}>
              <button
                type="button"
                data-testid="code-workspace-tree-dir"
                data-path={entry.path}
                className="h-7 w-full min-w-0 flex items-center gap-1.5 pr-2 text-left text-[12px] hover:bg-[var(--taomni-hover)]"
                style={rowStyle}
                title={entry.path}
                onClick={() => toggleDir(entry.path)}
              >
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
                )}
                <Folder className="w-3.5 h-3.5 shrink-0 text-[#d59d32]" />
                <span className="truncate">{entry.name}</span>
                {childState?.loading && <Loader2 className="ml-auto w-3 h-3 animate-spin" />}
              </button>
              {isExpanded && renderEntries(entry.path, depth + 1)}
            </Fragment>
          );
        }
        const active = activePath === entry.path;
        const open = openFiles[entry.path];
        return (
          <button
            key={entry.path}
            type="button"
            data-testid="code-workspace-tree-file"
            data-path={entry.path}
            data-active={active || undefined}
            className="h-7 w-full min-w-0 flex items-center gap-1.5 pr-2 text-left text-[12px] hover:bg-[var(--taomni-hover)] data-[active=true]:bg-[var(--taomni-selected)]"
            style={rowStyle}
            title={`${entry.path}${entry.size ? ` - ${formatBytes(entry.size)}` : ""}`}
            onClick={() => void openFile(entry.path)}
          >
            <span className="w-3.5 shrink-0" />
            <File className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
            <span className="truncate">{entry.name}</span>
            {open?.dirty && <span className="ml-auto text-[var(--taomni-accent)]">*</span>}
          </button>
        );
      });
    },
    [activePath, directories, expanded, openFile, openFiles, toggleDir, treeFilter],
  );

  return (
    <div
      data-testid="code-workspace-tab"
      className="h-full w-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
    >
      <header className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
        <Braces className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div className="min-w-0">
          <div className="font-semibold leading-4 truncate">Code · {title}</div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] truncate max-w-[520px]">
            {repoRoot}
          </div>
        </div>
        {dirtyCount > 0 && (
          <span className="rounded px-1.5 py-0.5 text-[11px] bg-[var(--taomni-selected)] text-[var(--taomni-accent)]">
            {dirtyCount} unsaved
          </span>
        )}
        <div className="flex-1" />
        <IconButton
          label="Save"
          icon={activeFile?.saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          disabled={!activeFile || !activeFile.dirty || activeFile.saving || activeFile.loading}
          onClick={() => void saveFile()}
        />
        <IconButton
          label="Reload"
          icon={<RotateCcw className="w-3.5 h-3.5" />}
          disabled={!activeFile || activeFile.loading}
          onClick={() => void reloadFile()}
        />
        <IconButton
          label="Refresh tree"
          icon={<RefreshCw className="w-3.5 h-3.5" />}
          onClick={refreshTree}
        />
      </header>

      <PanelGroup
        orientation="horizontal"
        id={`code-workspace-${repoRoot}`}
        className="flex-1 min-h-0"
      >
        <Panel id="project" defaultSize="22%" minSize="14%" maxSize="45%" className="min-w-0">
          <aside className="h-full min-h-0 flex flex-col border-r border-[var(--taomni-divider)] bg-[var(--taomni-sidebar-bg)]">
            <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
              <Search className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
              <input
                value={treeFilter}
                onChange={(event) => setTreeFilter(event.target.value)}
                placeholder="Filter"
                className="min-w-0 flex-1 bg-transparent outline-none text-[12px]"
              />
            </div>
            <div data-testid="code-workspace-tree" className="flex-1 min-h-0 overflow-auto py-1">
              {renderEntries("", 0)}
            </div>
          </aside>
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
        <Panel id="editor" defaultSize="78%" minSize="35%" className="min-w-0">
          <main className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)]">
            {openOrder.length > 0 && (
              <div className="h-8 shrink-0 flex items-end overflow-x-auto border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)]">
                {openOrder.map((path) => {
                  const file = openFiles[path];
                  const active = path === activePath;
                  return (
                    <div
                      key={path}
                      data-active={active || undefined}
                      className="h-7 min-w-[120px] max-w-[220px] flex items-center border-r border-[var(--taomni-divider)] text-[12px] data-[active=true]:bg-[var(--taomni-code-bg)]"
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 h-full flex items-center gap-1.5 px-2 text-left hover:bg-[var(--taomni-hover)]"
                        title={path}
                        onClick={() => setActivePath(path)}
                      >
                        <File className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
                        <span className="truncate">{basename(path)}</span>
                        {file?.dirty && <span className="text-[var(--taomni-accent)]">*</span>}
                      </button>
                      <button
                        type="button"
                        className="h-full w-6 shrink-0 inline-flex items-center justify-center hover:bg-[var(--taomni-hover)]"
                        title="Close"
                        onClick={() => void closeFile(path)}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex-1 min-h-0 relative">
              {activeFile ? (
                <div className="absolute inset-0 flex flex-col">
                  <div className="h-7 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)] bg-[var(--taomni-bg)] text-[11px] text-[var(--taomni-text-muted)]">
                    <span className="truncate">{activeFile.path}</span>
                    <span className="shrink-0">{formatBytes(activeFile.size)}</span>
                    {formatMtime(activeFile.mtime) && (
                      <span className="shrink-0">{formatMtime(activeFile.mtime)}</span>
                    )}
                    {activeFile.loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  </div>
                  {activeFile.error && (
                    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-red-500/30 bg-red-500/10 text-[12px] text-red-500">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span className="min-w-0 truncate">{activeFile.error}</span>
                    </div>
                  )}
                  <div data-testid="code-workspace-editor" className="flex-1 min-h-0">
                    {activeFile.loading ? (
                      <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                        <Loader2 className="w-4 h-4 animate-spin" />
                      </div>
                    ) : (
                      <WorkspaceCodeEditor
                        key={activeFile.path}
                        path={activeFile.path}
                        doc={activeFile.text}
                        visible={visible}
                        onChange={(doc) => updateFileText(activeFile.path, doc)}
                        onSave={() => void saveFile(activeFile.path)}
                      />
                    )}
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                  No file open
                </div>
              )}
            </div>
          </main>
        </Panel>
      </PanelGroup>
    </div>
  );
}

interface WorkspaceCodeEditorProps {
  path: string;
  doc: string;
  visible: boolean;
  onChange: (doc: string) => void;
  onSave: () => void;
}

function WorkspaceCodeEditor({
  path,
  doc,
  visible,
  onChange,
  onSave,
}: WorkspaceCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!hostRef.current) return;
    const saveHandler = () => {
      onSaveRef.current();
      return true;
    };
    const state = EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        rectangularSelection({
          eventFilter: (event) =>
            event.button === 0 && (event.altKey || (event.ctrlKey && event.shiftKey)),
        }),
        crosshairCursor(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        autocompletion(),
        languageCompartment.current.of([]),
        ...codeViewExtensions(),
        WORKSPACE_EDITOR_STYLE,
        keymap.of([
          { key: "Mod-s", run: saveHandler },
          { key: "Shift-Alt-ArrowUp", run: addCursorAbove },
          { key: "Shift-Alt-ArrowDown", run: addCursorBelow },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({
      state,
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void languageForPath(path)
      .then((language: Extension | null) => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure(language ?? []),
        });
      })
      .catch(() => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure([]),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === doc) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: doc },
    });
  }, [doc]);

  useEffect(() => {
    if (!visible) return;
    viewRef.current?.requestMeasure();
  }, [visible]);

  return <div ref={hostRef} className="h-full w-full" />;
}

function IconButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:cursor-default"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
