import type { EditorView } from "@codemirror/view";
import { useViewerLabels } from "../../viewer/viewerLabels";

export function DocumentMapPanel({
  content,
  view,
}: {
  content: string;
  view: EditorView | null;
}) {
  const label = useViewerLabels();
  const lines = content.split("\n").slice(0, 400);

  return (
    <div className="flex-1 overflow-auto p-1.5 font-mono text-[3px] leading-[5px] select-none" data-testid="notepad-doc-map">
      <div className="text-[10px] text-[var(--taomni-text-muted)] mb-1 font-sans">
        {label(`缩略图（${content.split("\n").length} 行）`, `Minimap (${content.split("\n").length} lines)`)}
      </div>
      {lines.map((line, i) => (
        <div
          key={i}
          className="cursor-pointer hover:bg-[var(--taomni-hover)] truncate opacity-75"
          style={{ minHeight: "4px" }}
          onClick={() => {
            if (!view) return;
            const lnNum = Math.min(view.state.doc.lines, i + 1);
            const pos = view.state.doc.line(lnNum).from;
            view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
            view.focus();
          }}
        >
          {line || " "}
        </div>
      ))}
    </div>
  );
}
