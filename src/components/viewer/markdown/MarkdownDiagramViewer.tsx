import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { diagramActions, type DiagramAction, type DiagramLabel } from "./diagramActions";
import type { DiagramSnapshot, DiagramTransform } from "./diagramModel";
import { portableWordSvg } from "./wordSvg";
import { useDiagramView } from "./useDiagramView";

export function MarkdownDiagramViewer({ snapshot, initialAction, label, busy, notice, onAction, onClose }: {
  snapshot: DiagramSnapshot; initialAction: DiagramAction; label: DiagramLabel; busy: boolean; notice: string;
  onAction: (action: DiagramAction, snapshot: DiagramSnapshot, transform: DiagramTransform) => void;
  onClose: () => void;
}) {
  const transform = useDiagramView(snapshot, initialAction);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [background, setBackground] = useState("checker");
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false, resource = "";
    void portableWordSvg(snapshot.svg, snapshot.width, snapshot.height, snapshot.theme === "dark").then((svg) => {
      if (disposed) return;
      resource = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })); setUrl(resource);
    }).catch((cause: unknown) => { if (!disposed) setError(String(cause)); });
    transform.stage.current?.focus();
    return () => { disposed = true; if (resource) URL.revokeObjectURL(resource); };
  }, [snapshot, transform.stage]);
  const viewActions = diagramActions(label).filter((entry) => entry.id !== "open");
  const action = (id: DiagramAction) => {
    if (/^(save|copy)-/.test(id)) onAction(id, snapshot, transform.view);
    else transform.action(id);
  };
  const { view, scale } = transform;
  return <div className="fv-md-diagram-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="fv fv-md-diagram-viewer" role="dialog" aria-modal="true" aria-label={label("Mermaid 图片查看器", "Mermaid image viewer")}
      data-testid="markdown-diagram-viewer" onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); return; }
        if (event.key === "Tab") {
          const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),select,[tabindex='0']") || []);
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          return;
        }
        if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || (event.target as Element).closest("input,textarea,select,[contenteditable=true]")) return;
        const id: DiagramAction | undefined = ({ "+": "zoom-in", "=": "zoom-in", "-": "zoom-out", "0": "actual", f: "fit", w: "width", r: "rotate-right", R: "rotate-left" } as Record<string, DiagramAction>)[event.key];
        if (id) { event.preventDefault(); event.stopPropagation(); action(id); }
        else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && event.target === transform.stage.current) {
          event.preventDefault(); transform.pan(event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0, event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0);
        }
      }}>
      <div className="fv-md-diagram-heading"><strong>{snapshot.filename}</strong><button type="button" className="fv-icon-button" data-testid="markdown-diagram-close" title={label("关闭 (Esc)", "Close (Esc)")} aria-label={label("关闭图片查看器", "Close image viewer")} onClick={onClose}><X /></button></div>
      <div className="fv-md-diagram-controls" role="toolbar" aria-label={label("图片查看操作", "Image viewing actions")}>
        {viewActions.map(({ id, title, Icon }) => <button key={id} type="button" className="fv-icon-button" data-testid={`markdown-diagram-view-${id}`} title={title} aria-label={title}
          disabled={busy && /^(save|copy)-/.test(id)} aria-pressed={id === "flip-h" ? view.flipX : id === "flip-v" ? view.flipY : undefined} onClick={() => action(id)}><Icon /></button>)}
        <output data-testid="markdown-diagram-zoom">{Math.round(scale * 100)}%</output>
        <select className="fv-select" data-testid="markdown-diagram-background" aria-label={label("查看器背景", "Viewer background")} value={background} onChange={(event) => setBackground(event.target.value)}>
          <option value="checker">{label("棋盘背景", "Checker background")}</option><option value="light">{label("浅色背景", "Light background")}</option><option value="dark">{label("深色背景", "Dark background")}</option>
        </select>
      </div>
      <div ref={transform.stage} className={`fv-md-diagram-stage background-${background}`} data-testid="markdown-diagram-stage" tabIndex={0}
        aria-label={label("拖动平移，滚轮缩放；方向键平移", "Drag to pan, wheel to zoom; arrow keys to pan")}
        data-rotation={view.rotation} data-flip-x={view.flipX} data-flip-y={view.flipY} data-scale={scale} data-pan-x={view.x} data-pan-y={view.y} data-view-mode={view.mode} {...transform.pointer}>
        {error ? <div role="alert">{error}</div> : url ? <img alt={label("Mermaid 图表", "Mermaid diagram")} src={url} draggable={false} width={snapshot.width} height={snapshot.height}
          onError={() => setError(label("无法显示图片，请重新打开图表", "Cannot display image; reopen the diagram"))}
          style={{ width: snapshot.width, height: snapshot.height, transform: `translate(-50%,-50%) translate(${view.x}px,${view.y}px) scale(${scale}) rotate(${view.rotation}deg) scale(${view.flipX ? -1 : 1},${view.flipY ? -1 : 1})` }} /> : <span role="status">{label("正在加载…", "Loading…")}</span>}
      </div>
      <div className="fv-md-diagram-footer" role="status" data-testid="markdown-diagram-status">{notice || label("拖动平移 · 滚轮缩放 · R 旋转 · Esc 关闭", "Drag to pan · Wheel to zoom · R to rotate · Esc to close")}</div>
    </div>
  </div>;
}
