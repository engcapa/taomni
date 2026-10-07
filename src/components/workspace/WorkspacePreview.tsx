import { useT } from "../../lib/i18n";
import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { RefreshCw } from "lucide-react";
import { workspaceReadFile } from "../../lib/editor/workspace";
import { renderFormatted } from "../../lib/chat/renderFormatted";
import type { Workspace } from "../../types/workspace";

/** Disk preview uses the same workspace-root boundary as the editor. */
export function WorkspacePreview({ workspace }: { workspace: Workspace }) {
  const t = useT();
  const [rootId, setRootId] = useState(workspace.roots[0]?.id ?? "");
  const [path, setPath] = useState("README.md");
  const [requested, setRequested] = useState({ rootId, path, revision: 0 });
  const [result, setResult] = useState<{ path: string; text: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const root = workspace.roots.find((candidate) => candidate.id === requested.rootId);
    if (!root) { setResult(null); return; }
    let disposed = false;
    setLoading(true); setError(""); setResult(null);
    void workspaceReadFile(root.path, requested.path).then((file) => {
      if (!disposed) setResult({ path: requested.path, text: file.text });
    }).catch((reason) => { if (!disposed) setError(String(reason)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [workspace.id, workspace.roots, requested]);
  return <section data-testid="workspace-preview" className="py-3">
    <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); setRequested({ rootId, path, revision: requested.revision + 1 }); }}>
      <select aria-label="Preview folder" className="taomni-input max-w-full" value={rootId} onChange={(event) => setRootId(event.target.value)}>{workspace.roots.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}</select>
      <input aria-label="Preview file path" data-testid="workspace-preview-path" className="taomni-input flex-1 min-w-0" value={path} onChange={(event) => setPath(event.target.value)} placeholder="README.md" />
      <button data-testid="workspace-preview-load" disabled={!rootId || !path.trim() || loading} className="flex items-center gap-1 rounded px-2 hover:bg-[var(--taomni-hover)]"><RefreshCw className="w-4 h-4" />{t("workspace.previewSaved")}</button>
    </form>
    {!workspace.roots.length && <p className="py-3">{t("workspace.previewAddFolder")}</p>}
    {loading && <p role="status" className="py-3">{t("workspace.previewLoading")}</p>}
    {error && <p role="alert" className="py-3 break-words">{error}</p>}
    {result && (/\.(md|markdown)$/i.test(result.path)
      ? <article data-testid="workspace-preview-content" className="prose max-w-none py-4 break-words" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderFormatted(result.text, "md") ?? "") }} />
      : <pre data-testid="workspace-preview-content" className="overflow-auto whitespace-pre-wrap break-words py-4">{result.text}</pre>)}
  </section>;
}
