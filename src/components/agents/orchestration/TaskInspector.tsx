import { FileText, X } from "lucide-react";
import { useEffect, useState } from "react";
import { previewAgentContext, type AgentContextPreview, type AgentRun } from "../../../lib/ipc/orchestration";
import { useOrchT } from "./locales";

export type InspectorTab = "sources" | "changes";
interface Props {
  tab: InspectorTab;
  run: AgentRun | null;
  projectPath: string;
  paths: string[];
  artifactId: string | null;
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
}

export function TaskInspector({ tab, run, projectPath, paths, artifactId, onTab, onClose }: Props) {
  const t = useOrchT();
  const [preview, setPreview] = useState<AgentContextPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [chosenArtifact, setChosenArtifact] = useState<string | null>(artifactId);

  useEffect(() => { setChosenArtifact(artifactId); }, [artifactId, run?.id]);
  useEffect(() => {
    let current = true;
    setPreview(null);
    setError(null);
    setLoading(false);
    if (run || !projectPath || tab !== "sources") return;
    setLoading(true);
    void previewAgentContext(projectPath, paths).then((result) => {
      if (current) setPreview(result);
    }).catch((reason: unknown) => {
      if (current) setError(String(reason));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [run, projectPath, paths, tab, retry]);

  const sources = run?.sources ?? preview?.sources ?? [];
  const artifact = run?.artifacts.find((entry) => entry.id === chosenArtifact) ?? run?.artifacts[0];

  return (
    <aside className="orch-inspector" data-testid="orch-inspector" aria-label={t("inspector")}>
      <div className="orch-inspector-heading">
        <button
          type="button"
          data-testid="orch-inspector-changes"
          className={`orch-inspector-tab ${tab === "changes" ? "active" : ""}`}
          onClick={() => onTab("changes")}
        >
          {t("changes")}
        </button>
        <button
          type="button"
          data-testid="orch-inspector-sources"
          className={`orch-inspector-tab ${tab === "sources" ? "active" : ""}`}
          onClick={() => onTab("sources")}
        >
          {t("context")}
        </button>
        <span className="orch-fill" />
        <button
          type="button"
          data-testid="orch-inspector-close"
          className="orch-icon-button"
          aria-label={t("close")}
          onClick={onClose}
        >
          <X />
        </button>
      </div>
      <div className="orch-inspector-content">
        {tab === "sources" ? (
          <div data-testid="orch-sources-panel">
            <div className="orch-inspector-subhead">
              <strong>{t("context")}</strong><span className="orch-muted orch-tiny">{t("readOnly")}</span>
            </div>
            {loading && <p role="status">{t("loading")}</p>}
            {error && (
              <div role="alert" className="orch-error">
                {error}
                <button
                  type="button"
                  className="orch-outline"
                  data-testid="orch-preview-retry"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  {t("retry")}
                </button>
              </div>
            )}
            {!loading && !error && !sources.length && <p className="orch-small-note">{t("noSources")}</p>}
            {sources.map((source) => (
              <details key={source.id} className="orch-source-body" data-testid={`orch-source-${source.id}`}>
                <summary><FileText />{source.path}</summary>
                <pre>{source.content}</pre><small title={t("hash")}>{source.hash}</small>
              </details>
            ))}
            {preview && (
              <>
                <p className="orch-small-note" data-testid="orch-context-estimate">
                  {t("estimate", { count: preview.estimatedInputTokens, method: preview.estimateMethod })}
                </p>
                {preview.warnings.map((warning, index) => <p key={index} className="orch-error">{warning}</p>)}
              </>
            )}
            <p className="orch-inspector-note">{t("sourceNote")}</p>
          </div>
        ) : (
          <div data-testid="orch-artifacts-panel">
            <div className="orch-inspector-subhead">
              <strong>{t("changes")}</strong><span className="orch-subtle-badge">{t("candidateArtifacts")}</span>
            </div>
            {!run?.artifacts.length && <p className="orch-small-note">{t("noArtifacts")}</p>}
            {run?.artifacts.map((entry) => (
              <button
                key={entry.id}
                type="button"
                data-testid={`orch-artifact-${entry.id}`}
                className={`orch-changed-file ${entry.id === artifact?.id ? "active" : ""}`}
                onClick={() => setChosenArtifact(entry.id)}
              >
                <FileText /><span>{entry.name}</span><span className="orch-muted orch-tiny">{entry.format}</span>
              </button>
            ))}
            {artifact && (
              <div className="orch-diff-preview">
                <div className="orch-diff-title">{artifact.name}</div>
                <pre data-testid="orch-artifact-content">{artifact.content}</pre>
                <small title={t("hash")}>{artifact.hash}</small>
              </div>
            )}
            <p className="orch-inspector-note">{t("candidateNote")}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
