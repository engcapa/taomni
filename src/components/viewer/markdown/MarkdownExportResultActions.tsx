import { useAppStore } from "../../../stores/appStore";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { NOTES_WORKSPACE_ID } from "../../../stores/workspaceNotes";
import { openFile, classifyFile, supportsFileViewer } from "../../../lib/openFile";
import { openExplorer } from "../../../lib/explorer/openExplorer";
import { markdownDirectory } from "../../../lib/markdownAssets";
import { sftpOpenPath } from "../../../lib/sftp";
import { useViewerLabels } from "../viewerLabels";
import { documentProvider } from "../../../lib/openFile/documentProvider";
import { fileExtension } from "../../../lib/openFile/classifyFile";
import { usePluginFrontendStore } from "../../../stores/pluginFrontendStore";

/** Capture the export's owner before a chooser or generation yields. */
export function exportWorkspaceId(): string | undefined {
  const id = useWorkspacePlatformStore.getState().activeWorkspaceId;
  return useAppStore.getState().activeSideTab === "workspaces" && id !== NOTES_WORKSPACE_ID ? id : undefined;
}

export function MarkdownExportResultActions({ path, filePath, workspaceId, onError }: {
  path: string;
  filePath: string;
  workspaceId?: string;
  onError: (message: string) => void;
}) {
  const label = useViewerLabels();
  const kind = classifyFile(filePath);
  const provider = documentProvider(filePath);
  const ready = usePluginFrontendStore((state) => {
    if (!provider) return false;
    const record = state.records[provider.slug];
    return state.status === "ready" && !state.pending.has(provider.slug)
      && record?.lifecycle === "enabled" && record.manifest?.document?.extensions.includes(fileExtension(filePath));
  });
  const preview = provider ? ready : supportsFileViewer(kind) || kind === "source";
  const directory = path !== filePath ? path : markdownDirectory(filePath);
  const run = (action: () => Promise<unknown>) => {
    void Promise.resolve().then(action).catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));
  };
  return <>
    <button type="button" className="fv-button primary" data-testid="markdown-export-open-tao"
      onClick={() => run(() => preview
        ? openFile(filePath, { context: "markdown-export", mode: "taomni", workspaceId })
        : openExplorer(directory, { workspaceId }))}>
      {preview ? label("用 Tao 打开", "Open with Tao") : label("在 Tao 中显示", "Show in Tao")}
    </button>
    <button type="button" className="fv-button outline" data-testid="markdown-export-show-system"
      onClick={() => run(() => sftpOpenPath(directory))}>
      {label("在系统文件管理器中显示", "Show in system file manager")}
    </button>
  </>;
}
