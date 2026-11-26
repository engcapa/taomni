import { useEffect, useState } from "react";
import { ModalSurface } from "../../ui/ModalSurface";
import type { DrawioPage } from "./drawioCodec";
import { drawioToMarkdown, type DrawioImportMode } from "./drawioImport";
import { renderDrawioPage, safeDrawioModel, type DrawioPreview } from "./drawioRender";
import { drawioMissingImagesMessage } from "./drawioImageStyle";
import { useViewerLabels } from "../viewerLabels";
import "./drawio.css";

export function DrawioImportDialog({ pages, returnFocus, onCancel, onInsert }: { pages: DrawioPage[]; returnFocus?: HTMLElement | null; onCancel: () => void; onInsert: (markdown: string) => void }) {
  const label = useViewerLabels();
  const [selected, setSelected] = useState(() => new Set(pages.map((page) => page.id)));
  const [active, setActive] = useState(pages[0].id);
  const [mode, setMode] = useState<DrawioImportMode | "">("");
  const [preview, setPreview] = useState<DrawioPreview | null>(null);
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState(false);
  useEffect(() => {
    let disposed = false;
    setPreview(null); setError(""); setRendering(true);
    void renderDrawioPage(pages.find((page) => page.id === active)!).then((result) => { if (!disposed) setPreview(result); })
      .catch((cause: unknown) => { if (!disposed) setError(String(cause)); }).finally(() => { if (!disposed) setRendering(false); });
    return () => { disposed = true; };
  }, [active, pages]);
  return <ModalSurface
    dismissOnBackdrop
    initialFocus="button:enabled"
    returnFocus={returnFocus}
    onCancel={onCancel}
    className="fv-modal fv-md-drawio-dialog"
    aria-labelledby="fv-drawio-import-title"
    data-testid="markdown-drawio-import-dialog"
  >
    <h3 id="fv-drawio-import-title">{label("导入 draw.io", "Import draw.io")}</h3>
    <div className="fv-md-drawio-sheets">
      <div className="fv-md-drawio-sheet-list">
        <button type="button" className="fv-button outline" data-testid="markdown-drawio-select-all" onClick={() => setSelected(selected.size === pages.length ? new Set() : new Set(pages.map((page) => page.id)))}>{label("全选 / 取消全选", "Select / deselect all")}</button>
        {pages.map((page) => <div key={page.id} className={active === page.id ? "on" : ""}>
          <input type="checkbox" aria-label={`${label("导入页面", "Import sheet")} ${page.name}`} data-testid="markdown-drawio-sheet-check" checked={selected.has(page.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(page.id)) next.delete(page.id); else next.add(page.id); return next; })} />
          <button type="button" data-testid="markdown-drawio-sheet-preview" aria-pressed={active === page.id} onClick={() => setActive(page.id)}>{page.name}</button>
        </div>)}
      </div>
      <div className="fv-md-drawio-preview" data-testid="markdown-drawio-import-preview">
        {rendering && <p role="status">{label("正在生成预览…", "Rendering preview…")}</p>}
        {preview && <>
          <div dangerouslySetInnerHTML={{ __html: preview.svg }} />
          {preview.missingImages > 0 && <p role="status">{drawioMissingImagesMessage(preview.missingImages)}</p>}
          {preview.warnings.map((warning) => <p key={warning} role="status">{warning}</p>)}
        </>}
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
    <fieldset className="fv-md-drawio-import-mode"><legend>{label("请选择导入方式", "Choose how to import")}</legend>
      <label><input type="radio" name="drawio-import-mode" data-testid="markdown-drawio-import-diagram" checked={mode === "diagram"} onChange={() => setMode("diagram")} />{label("保留 Sheet 图形布局", "Preserve sheet diagrams")}</label>
      <label><input type="radio" name="drawio-import-mode" data-testid="markdown-drawio-import-text" checked={mode === "text"} onChange={() => setMode("text")} />{label("优先还原 Markdown 文字和表格，其余保留图形", "Restore Markdown text/tables, preserve other diagrams")}</label>
    </fieldset>
    <p>{label("所选页面原始数据随 Markdown 保留，可离线预览。文字模式仅转换可识别的文本和表格。", "Selected original pages stay in Markdown for offline preview. Text mode converts recognized text and tables.")}</p>
    <footer><button type="button" className="fv-button outline" onClick={onCancel}>{label("取消", "Cancel")}</button><button type="button" className="fv-button primary" data-testid="markdown-drawio-import-confirm" disabled={!mode || !selected.size || rendering || !!error} onClick={() => {
      if (!mode) return;
      try {
        const selection = pages.filter((page) => selected.has(page.id));
        selection.forEach((page) => safeDrawioModel(page));
        onInsert(drawioToMarkdown(selection, mode));
      } catch (cause) { setError(String(cause)); }
    }}>{label("插入所选页面", "Insert selected sheets")} ({selected.size})</button></footer>
  </ModalSurface>;
}
