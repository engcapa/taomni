import { useEffect, useRef } from "react";
import { useViewerLabels } from "../viewerLabels";
import { DEFAULT_DRAWIO_OPTIONS, type DrawioExportOptions } from "./drawioExport";
import type { MarkdownExportKind, MarkdownExportSettings } from "./exportModel";

export function DrawioExportSettings({ settings, onChange, onCancel, onConfirm }: {
  settings: MarkdownExportSettings; onChange: (value: MarkdownExportSettings) => void; onCancel: () => void;
  onConfirm: (kind: MarkdownExportKind) => void;
}) {
  const label = useViewerLabels(), root = useRef<HTMLDivElement>(null);
  const options = settings.drawio || DEFAULT_DRAWIO_OPTIONS;
  const patch = (value: Partial<DrawioExportOptions>) => onChange({ ...settings, drawio: { ...options, ...value } });
  useEffect(() => { root.current?.querySelector<HTMLSelectElement>("select")?.focus(); }, []);
  return <div className="fv-modal-bg" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><div ref={root} className="fv-modal fv-md-export-settings" role="dialog" aria-modal="true" aria-labelledby="fv-drawio-export-title" data-testid="markdown-drawio-export-settings" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
    if (event.key === "Tab") {
      const nodes = Array.from(root.current?.querySelectorAll<HTMLElement>("button,select") || []);
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
    }
  }}>
    <h3 id="fv-drawio-export-title">{label("导出 draw.io", "Export draw.io")}</h3>
    <div className="fv-md-export-fields">
      <label className="fv-md-field"><span>{label("导出内容", "Content")}</span><select className="fv-select" data-testid="markdown-drawio-scope" value={options.scope} onChange={(event) => patch({ scope: event.target.value as DrawioExportOptions["scope"] })}>
        <option value="document">{label("全文档（文字、表格、全部图片）", "Whole document (text, tables, all images)")}</option><option value="images">{label("全部图片和图表", "All images and diagrams")}</option>
      </select></label>
      <label className="fv-md-field"><span>{label("Sheet 布局", "Sheet layout")}</span><select className="fv-select" data-testid="markdown-drawio-layout" value={options.layout} onChange={(event) => patch({ layout: event.target.value as DrawioExportOptions["layout"] })}>
        <option value="separate">{options.scope === "document" ? label("文档页 + 每图独立 Sheet", "Document sheet + one sheet per image") : label("每图独立 Sheet", "One sheet per image")}</option><option value="single">{label("所有内容放同一 Sheet", "All content in one sheet")}</option>
      </select></label>
      <p className="fv-md-export-hint">{label("标题、正文与表格单元格可编辑。Mermaid 优先转换为节点和连线；不支持的类型保留 SVG 和源码，结果会提示回退数量。", "Headings, text and table cells stay editable. Mermaid converts to nodes and connectors where supported; other types keep SVG and source, with fallback counts reported.")}</p>
      <p className="fv-md-export-hint">{label("在线链接包含所选内容，在本地生成；打开时交给系统浏览器。超大内容请保存文件。", "Online links contain the selected content and are generated locally. Open uses your system browser. Save a file for large documents.")}</p>
    </div>
    <footer style={{ flexWrap: "wrap" }}><button type="button" className="fv-button outline" onClick={onCancel}>{label("取消", "Cancel")}</button>
      <button type="button" className="fv-button outline" data-testid="markdown-drawio-copy-link" onClick={() => onConfirm("drawio-link")}>{label("复制在线链接", "Copy online link")}</button>
      <button type="button" className="fv-button outline" data-testid="markdown-drawio-open-link" onClick={() => onConfirm("drawio-open")}>{label("在线打开", "Open online")}</button>
      <button type="button" className="fv-button primary" data-testid="markdown-drawio-save" onClick={() => onConfirm("drawio")}>{label("保存 .drawio 文件", "Save .drawio file")}</button>
    </footer>
  </div></div>;
}
