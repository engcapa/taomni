import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { GitBranch, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { languageFromPath, useWorkspaceEditorStore } from "../../stores/workspaceEditorStore";
import type { PlatformWorkspace, WorkspaceIsolatedTab } from "../../stores/workspacePlatformStore";
import { readWorkspaceText, writeWorkspaceText } from "./workspaceFs";

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12px",
    backgroundColor: "var(--taomni-code-bg)",
    color: "var(--taomni-code-text)",
  },
  ".cm-scroller": { fontFamily: "var(--taomni-mono-font, ui-monospace, SFMono-Regular, Menlo, monospace)" },
  ".cm-gutters": {
    backgroundColor: "var(--taomni-code-gutter-bg)",
    color: "var(--taomni-code-muted)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "var(--taomni-code-active-line-bg)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--taomni-code-active-line-bg)" },
  ".cm-content": { caretColor: "var(--taomni-code-text)" },
  ".cm-cursor": { borderLeftColor: "var(--taomni-code-text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "var(--taomni-selected)" },
});

export interface WorkspaceFileEditorProps {
  workspace: PlatformWorkspace;
  tab: WorkspaceIsolatedTab;
  visible: boolean;
  onOpenGitDiff: (path: string) => void;
}

/**
 * File editor surface of the Workspaces canvas (AC-06 path C).
 *
 * A focused CodeMirror editor over the workspace root folder: open, edit and
 * save a file, and jump straight into the workspace Git panel for the same
 * file from the editor toolbar.
 */
export function WorkspaceFileEditor({ workspace, tab, visible, onOpenGitDiff }: WorkspaceFileEditorProps) {
  const t = useT();
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const setDocument = useWorkspaceEditorStore((s) => s.setDocument);
  const document = useWorkspaceEditorStore((s) => s.documents[tab.id]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedHashRef = useRef<string | null>(null);
  const loadedPathRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);

  const root = workspace.rootFolders.find((folder) => folder.id === tab.rootFolderId);
  const path = tab.filePath ?? "";
  const language = languageFromPath(path);

  useEffect(() => {
    if (!root || !path) return;
    const loadKey = `${root.id}:${path}`;
    if (loadedPathRef.current === loadKey) return;
    loadedPathRef.current = loadKey;
    let cancelled = false;
    setDocument(tab.id, { path, language, loading: true, error: null });
    void (async () => {
      try {
        const file = await readWorkspaceText(root.path, path);
        if (cancelled) return;
        savedHashRef.current = file.hash ?? null;
        setDocument(tab.id, {
          path,
          language,
          text: file.text,
          savedText: file.text,
          dirty: false,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (cancelled) return;
        setDocument(tab.id, {
          path,
          language,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [language, path, root, setDocument, tab.id]);

  useEffect(() => {
    if (!document || document.loading) return;
    const host = hostRef.current;
    if (!host) return;
    if (viewRef.current) {
      if (viewRef.current.state.doc.toString() === document.text) return;
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: document.text },
      });
      return;
    }
    const state = EditorState.create({
      doc: document.text,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        editorTheme,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          const current = useWorkspaceEditorStore.getState().documents[tab.id];
          if (!current) return;
          setDocument(tab.id, { text, dirty: text !== current.savedText });
        }),
      ],
    });
    viewRef.current = new EditorView({ state, parent: host });
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // The view owns its document after creation; external updates are applied
    // above through the `document.text` sync branch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document?.loading, tab.id]);

  useEffect(() => () => {
    viewRef.current?.destroy();
    viewRef.current = null;
  }, []);

  const save = async () => {
    if (!root || !path || saving) return;
    const current = useWorkspaceEditorStore.getState().documents[tab.id];
    if (!current || !current.dirty) return;
    setSaving(true);
    try {
      const file = await writeWorkspaceText(root.path, path, current.text, savedHashRef.current);
      savedHashRef.current = file.hash ?? null;
      setDocument(tab.id, { savedText: current.text, dirty: false });
      setStatusMessage(`Saved ${path}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="workspace-file-editor"
      data-path={path}
      data-dirty={document?.dirty || undefined}
      className="flex h-full min-h-0 w-full flex-col"
      style={{ display: visible ? "flex" : "none" }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void save();
        }
      }}
    >
      <div
        className="flex h-8 shrink-0 items-center gap-2 border-b px-2"
        style={{ borderColor: "var(--taomni-code-border)", background: "var(--taomni-card-bg)" }}
      >
        <span className="truncate text-[11.5px] font-semibold" data-testid="workspace-editor-title">
          {path}
          {document?.dirty && <span style={{ color: "var(--taomni-warning, #d97706)" }}> ●</span>}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-testid="workspace-editor-save"
            className="taomni-btn h-6 px-1.5 inline-flex items-center gap-1"
            disabled={!document?.dirty || saving}
            onClick={() => void save()}
          >
            <Save className="h-3.5 w-3.5" />
            {t("platform.saveFile")}
          </button>
          <button
            type="button"
            data-testid="editor-open-git-diff"
            className="taomni-btn h-6 px-1.5 inline-flex items-center gap-1"
            onClick={() => onOpenGitDiff(path)}
          >
            <GitBranch className="h-3.5 w-3.5" />
            {t("platform.openInGit")}
          </button>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        {document?.error && (
          <div data-testid="workspace-editor-error" className="p-3 text-[12px]" style={{ color: "var(--taomni-danger)" }}>
            {document.error}
          </div>
        )}
        {!document?.error && <div ref={hostRef} className="h-full min-h-0 w-full overflow-hidden" />}
      </div>
    </div>
  );
}
