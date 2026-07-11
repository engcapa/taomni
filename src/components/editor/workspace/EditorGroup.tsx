import type { CSSProperties, MutableRefObject, ReactNode } from "react";
import {
  AlertTriangle,
  Columns2,
  Eye,
  File,
  Loader2,
  X,
} from "lucide-react";
import type { LspCapabilitySummary, LspDiagnostic, LspPosition } from "../../../lib/editor/lsp";
import type {
  LspCompletionItem,
  LspCompletionResult,
  LspSignatureHelpResult,
} from "../../../lib/editor/lsp";
import { CodeMirrorHost, type EditorSelectionRange } from "./CodeMirrorHost";
import type { OpenFileViewModel } from "./editorGroupTypes";

export type MarkdownViewMode = "edit" | "preview" | "split";

export interface EditorRevealTarget {
  key: string;
  line: number;
  character: number;
  nonce: number;
}

interface EditorGroupProps {
  workspaceInstanceId: string;
  visible: boolean;
  openOrder: string[];
  openFiles: Record<string, OpenFileViewModel>;
  activeKey: string | null;
  activeFile: OpenFileViewModel | null;
  activeMarkdownMode: MarkdownViewMode;
  activeDiagnostics: LspDiagnostic[];
  activeCapabilities: LspCapabilitySummary | null;
  activeLspSyncing: boolean;
  lspStatusPill: ReactNode;
  revealTarget: EditorRevealTarget | null;
  editorPaneRef: MutableRefObject<HTMLElement | null>;
  editorPaneStyle: CSSProperties;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onMarkdownModeChange: (mode: MarkdownViewMode) => void;
  onChangeText: (key: string, text: string) => void;
  onSave: (key: string) => void;
  onHover: (file: OpenFileViewModel, position: LspPosition) => Promise<string | null>;
  onDefinition: (file: OpenFileViewModel, position: LspPosition) => Promise<boolean>;
  onReferences: (file: OpenFileViewModel, position: LspPosition) => Promise<void>;
  onComplete: (
    file: OpenFileViewModel,
    position: LspPosition,
    trigger: string | null,
  ) => Promise<LspCompletionResult | null>;
  onCompleteResolve: (file: OpenFileViewModel, raw: unknown) => Promise<LspCompletionItem | null>;
  onSignatureHelp: (
    file: OpenFileViewModel,
    position: LspPosition,
    trigger: string | null,
  ) => Promise<LspSignatureHelpResult | null>;
  onSelectionChange: (selection: EditorSelectionRange) => void;
  onLightbulb: (line: number) => void;
  onOpenMarkdownHref: (href: string) => boolean;
  formatBytes: (size: number) => string;
  formatMtime: (mtime: number) => string;
  isMarkdownPath: (path: string) => boolean;
  renderMarkdownPreview: (file: OpenFileViewModel, onOpenHref: (href: string) => boolean) => ReactNode;
}

/**
 * Single editor group: tab strip + active buffer chrome + CodeMirror/markdown.
 * File buffers and LSP sessions stay owned by the shell/store; this is the
 * presentation boundary for the center pane (M3 will grow this into multi-group).
 */
export function EditorGroup({
  workspaceInstanceId,
  visible,
  openOrder,
  openFiles,
  activeKey,
  activeFile,
  activeMarkdownMode,
  activeDiagnostics,
  activeCapabilities,
  activeLspSyncing,
  lspStatusPill,
  revealTarget,
  editorPaneRef,
  editorPaneStyle,
  onActivate,
  onClose,
  onMarkdownModeChange,
  onChangeText,
  onSave,
  onHover,
  onDefinition,
  onReferences,
  onComplete,
  onCompleteResolve,
  onSignatureHelp,
  onSelectionChange,
  onLightbulb,
  onOpenMarkdownHref,
  formatBytes,
  formatMtime,
  isMarkdownPath,
  renderMarkdownPreview,
}: EditorGroupProps) {
  return (
    <main
      ref={editorPaneRef}
      data-testid="code-workspace-editor-pane"
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)]"
      style={editorPaneStyle}
    >
      {openOrder.length > 0 && (
        <div className="h-8 shrink-0 flex items-end overflow-x-auto border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]">
          {openOrder.map((key) => {
            const file = openFiles[key];
            if (!file) return null;
            const active = key === activeKey;
            return (
              <div
                key={key}
                data-active={active || undefined}
                className="h-[var(--taomni-code-editor-tab-height)] min-w-[130px] max-w-[240px] flex items-center border-r border-[var(--taomni-code-border)] text-[length:var(--taomni-code-editor-ui-small-font-size)] text-[var(--taomni-code-muted)] data-[active=true]:bg-[var(--taomni-code-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 h-full flex items-center gap-1.5 px-2 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                  title={file.subtitle}
                  onClick={() => onActivate(key)}
                >
                  <File className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
                  <span className="truncate">{file.title}</span>
                  {file.dirty && <span className="text-[var(--taomni-accent)]">*</span>}
                </button>
                <button
                  type="button"
                  className="h-full w-6 shrink-0 inline-flex items-center justify-center hover:bg-[var(--taomni-code-active-line-bg)]"
                  title="Close"
                  onClick={() => onClose(key)}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div
        id={`code-workspace-editor-stack-${workspaceInstanceId}`}
        className="flex-1 min-h-0"
      >
        <div className="h-full min-h-0 relative">
          {activeFile ? (
            <div className="absolute inset-0 flex flex-col">
              <div className="min-h-7 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] text-[length:var(--taomni-code-editor-ui-small-font-size)] text-[var(--taomni-code-muted)]">
                <span className="truncate">{activeFile.subtitle}</span>
                <span className="shrink-0">{formatBytes(activeFile.size)}</span>
                {formatMtime(activeFile.mtime) && (
                  <span className="shrink-0">{formatMtime(activeFile.mtime)}</span>
                )}
                {activeFile.loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {activeLspSyncing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {lspStatusPill}
                {isMarkdownPath(activeFile.languagePath) && (
                  <div className="ml-auto flex items-center gap-0.5">
                    <ModeButton
                      label="Edit"
                      active={activeMarkdownMode === "edit"}
                      icon={<File className="w-3 h-3" />}
                      onClick={() => onMarkdownModeChange("edit")}
                    />
                    <ModeButton
                      label="Preview"
                      active={activeMarkdownMode === "preview"}
                      icon={<Eye className="w-3 h-3" />}
                      onClick={() => onMarkdownModeChange("preview")}
                    />
                    <ModeButton
                      label="Split"
                      active={activeMarkdownMode === "split"}
                      icon={<Columns2 className="w-3 h-3" />}
                      onClick={() => onMarkdownModeChange("split")}
                    />
                  </div>
                )}
              </div>
              {activeFile.error && (
                <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-red-500/30 bg-red-500/10 text-[12px] text-red-500">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span className="min-w-0 truncate">{activeFile.error}</span>
                </div>
              )}
              <div data-testid="code-workspace-editor" className="flex-1 min-h-0">
                {activeFile.loading ? (
                  <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-code-muted)]">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </div>
                ) : isMarkdownPath(activeFile.languagePath) && activeMarkdownMode === "preview" ? (
                  renderMarkdownPreview(activeFile, onOpenMarkdownHref)
                ) : isMarkdownPath(activeFile.languagePath) && activeMarkdownMode === "split" ? (
                  <div className="h-full min-h-0 grid grid-cols-2">
                    <div className="min-w-0 min-h-0 border-r border-[var(--taomni-code-border)]">
                      <CodeMirrorHost
                        key={`${activeFile.key}:edit`}
                        path={activeFile.languagePath}
                        doc={activeFile.text}
                        visible={visible}
                        diagnostics={activeDiagnostics}
                        reveal={revealTarget?.key === activeFile.key ? revealTarget : null}
                        onChange={(doc) => onChangeText(activeFile.key, doc)}
                        onSave={() => onSave(activeFile.key)}
                        onHover={(position) => onHover(activeFile, position)}
                        onDefinition={(position) => onDefinition(activeFile, position)}
                        onReferences={(position) => onReferences(activeFile, position)}
                        onComplete={(position, trigger) => onComplete(activeFile, position, trigger)}
                        onCompleteResolve={(raw) => onCompleteResolve(activeFile, raw)}
                        onSignatureHelp={(position, trigger) => onSignatureHelp(activeFile, position, trigger)}
                        onSelectionChange={onSelectionChange}
                        onLightbulb={onLightbulb}
                        completionTriggers={activeCapabilities?.completionTriggerCharacters ?? []}
                        signatureTriggers={activeCapabilities?.signatureTriggerCharacters ?? []}
                      />
                    </div>
                    {renderMarkdownPreview(activeFile, onOpenMarkdownHref)}
                  </div>
                ) : (
                  <CodeMirrorHost
                    key={activeFile.key}
                    path={activeFile.languagePath}
                    doc={activeFile.text}
                    visible={visible}
                    diagnostics={activeDiagnostics}
                    reveal={revealTarget?.key === activeFile.key ? revealTarget : null}
                    onChange={(doc) => onChangeText(activeFile.key, doc)}
                    onSave={() => onSave(activeFile.key)}
                    onHover={(position) => onHover(activeFile, position)}
                    onDefinition={(position) => onDefinition(activeFile, position)}
                    onReferences={(position) => onReferences(activeFile, position)}
                    onComplete={(position, trigger) => onComplete(activeFile, position, trigger)}
                    onCompleteResolve={(raw) => onCompleteResolve(activeFile, raw)}
                    onSignatureHelp={(position, trigger) => onSignatureHelp(activeFile, position, trigger)}
                    onSelectionChange={onSelectionChange}
                    onLightbulb={onLightbulb}
                    completionTriggers={activeCapabilities?.completionTriggerCharacters ?? []}
                    signatureTriggers={activeCapabilities?.signatureTriggerCharacters ?? []}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-code-muted)]">
              No file open
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function ModeButton({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active?: boolean;
  icon: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-active={active || undefined}
      className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[10px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
