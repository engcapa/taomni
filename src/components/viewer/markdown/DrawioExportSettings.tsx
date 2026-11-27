import { ModalSurface } from "../../ui/ModalSurface";
import { ThemedSelect } from "../../ThemedSelect";
import { useViewerLabels } from "../viewerLabels";
import { DEFAULT_DRAWIO_OPTIONS, type DrawioExportOptions } from "./drawioExport";
import type { MarkdownExportKind, MarkdownExportSettings } from "./exportModel";

export function DrawioExportSettings({ settings, returnFocus, onChange, onCancel, onConfirm }: {
  settings: MarkdownExportSettings; returnFocus?: HTMLElement | null; onChange: (value: MarkdownExportSettings) => void; onCancel: () => void;
  onConfirm: (kind: MarkdownExportKind) => void;
}) {
  const label = useViewerLabels();
  const options = settings.drawio || DEFAULT_DRAWIO_OPTIONS;
  const patch = (value: Partial<DrawioExportOptions>) => onChange({ ...settings, drawio: { ...options, ...value } });
  return <ModalSurface
    dismissOnBackdrop
    initialFocus="[role=combobox], button:enabled"
    returnFocus={returnFocus}
    onCancel={onCancel}
    className="fv-modal fv-md-export-settings"
    aria-labelledby="fv-drawio-export-title"
    data-testid="markdown-drawio-export-settings"
  >
    <h3 id="fv-drawio-export-title">{label("导出 draw.io", "Export draw.io")}</h3>
    <div className="fv-md-export-fields">
      <div className="fv-md-field"><span>{label("导出内容", "Content")}</span>
        <ThemedSelect label={label("导出内容", "Content")} testId="markdown-drawio-scope" value={options.scope} onChange={(scope) => patch({ scope })} options={[
          { value: "document", label: label("全文档（文字、表格、全部图片）", "Whole document (text, tables, all images)") },
          { value: "images", label: label("全部图片和图表", "All images and diagrams") },
        ]} />
      </div>
      <div className="fv-md-field"><span>{label("Sheet 布局", "Sheet layout")}</span>
        <ThemedSelect label={label("Sheet 布局", "Sheet layout")} testId="markdown-drawio-layout" value={options.layout} onChange={(layout) => patch({ layout })} options={[
          { value: "separate", label: options.scope === "document" ? label("文档页 + 每图独立 Sheet", "Document sheet + one sheet per image") : label("每图独立 Sheet", "One sheet per image") },
          { value: "single", label: label("所有内容放同一 Sheet", "All content in one sheet") },
        ]} />
      </div>
      <p className="fv-md-export-hint">{label("标题、正文与表格单元格可编辑。Mermaid 优先转换为节点和连线；不支持的类型保留 SVG 和源码，结果会提示回退数量。", "Headings, text and table cells stay editable. Mermaid converts to nodes and connectors where supported; other types keep SVG and source, with fallback counts reported.")}</p>
      <p className="fv-md-export-hint">{label("在线链接包含所选内容，在本地生成；打开时交给系统浏览器。超大内容请保存文件。", "Online links contain the selected content and are generated locally. Open uses your system browser. Save a file for large documents.")}</p>
    </div>
    <footer style={{ flexWrap: "wrap" }}><button type="button" className="fv-button outline" onClick={onCancel}>{label("取消", "Cancel")}</button>
      <button type="button" className="fv-button outline" data-testid="markdown-drawio-copy-link" onClick={() => onConfirm("drawio-link")}>{label("复制在线链接", "Copy online link")}</button>
      <button type="button" className="fv-button outline" data-testid="markdown-drawio-open-link" onClick={() => onConfirm("drawio-open")}>{label("在线打开", "Open online")}</button>
      <button type="button" className="fv-button primary" data-testid="markdown-drawio-save" onClick={() => onConfirm("drawio")}>{label("保存 .drawio 文件", "Save .drawio file")}</button>
    </footer>
  </ModalSurface>;
}
