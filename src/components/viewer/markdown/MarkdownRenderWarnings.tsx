import { TriangleAlert, X } from "lucide-react";
import { useViewerLabels } from "../viewerLabels";
import type { MarkdownRenderWarning } from "./markdownRenderFallback";

export function MarkdownRenderWarnings({ warnings, onDismiss }: {
  warnings: MarkdownRenderWarning[];
  onDismiss: () => void;
}) {
  const label = useViewerLabels();
  if (!warnings.length) return null;
  const hiddenCount = Math.max(0, warnings.length - 3);
  return <section className="fv-md-render-warnings" data-testid="markdown-render-warnings" role="alert" aria-live="polite">
    <TriangleAlert aria-hidden="true" />
    <div className="fv-md-render-warnings-content">
      <strong>{label(
        `${warnings.length} 个元素无法渲染，预览和导出将使用占位符。`,
        `${warnings.length} element${warnings.length === 1 ? "" : "s"} could not be rendered. Preview and export will use placeholders.`,
      )}</strong>
      <ul>
        {warnings.slice(0, 3).map((warning) => <li key={warning.id} data-testid="markdown-render-warning-item" title={warning.message}>
          <span>{warning.label}</span> — {warning.message}
        </li>)}
      </ul>
      {hiddenCount ? <span>{label(`另有 ${hiddenCount} 个警告`, `${hiddenCount} more warning${hiddenCount === 1 ? "" : "s"}`)}</span> : null}
    </div>
    <button type="button" className="fv-icon-button" data-testid="markdown-render-warning-dismiss"
      aria-label={label("关闭渲染警告", "Dismiss render warnings")} title={label("关闭渲染警告", "Dismiss render warnings")}
      onClick={onDismiss}><X aria-hidden="true" /></button>
  </section>;
}
