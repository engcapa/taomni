import { useState } from "react";
import { FileText, RotateCcw } from "lucide-react";
import { AppProxyPanel } from "./AppProxyPanel";
import { useLocale } from "../../lib/i18n";
import { resetFileOpenPreferences, setFileOpenPreferences, useFileOpenPreferences } from "../../lib/openFile/preferences";

type Handler = "taomni" | "workspace" | "system";
const GROUPS: Array<{ id: string; extensions: string[]; zh: string; en: string; handler: Handler }> = [
  { id: "image", extensions: ["png", "jpg", "gif", "webp", "bmp", "ico", "avif"], zh: "图片查看器", en: "Image viewer", handler: "taomni" },
  { id: "svg", extensions: ["svg"], zh: "SVG 查看器（渲染+代码）", en: "SVG viewer (render + code)", handler: "taomni" },
  { id: "text", extensions: ["txt", "log", "ini", "conf", "env"], zh: "文本编辑器", en: "Text editor", handler: "taomni" },
  { id: "data", extensions: ["json", "yaml", "toml", "xml", "csv"], zh: "文本编辑器（CSV 有表格视图）", en: "Text editor (CSV table view)", handler: "taomni" },
  { id: "markdown", extensions: ["md", "markdown"], zh: "Markdown 编辑器（实时渲染）", en: "Markdown editor (live rendering)", handler: "taomni" },
  { id: "html", extensions: ["html", "htm"], zh: "HTML 预览", en: "HTML preview", handler: "taomni" },
  { id: "source", extensions: ["ts", "tsx", "js", "jsx", "rs", "py", "java", "go", "c", "cpp"], zh: "Code Workspace 编辑器", en: "Code Workspace editor", handler: "workspace" },
  { id: "binary", extensions: ["pdf", "docx", "xlsx", "zip"], zh: "系统默认应用", en: "System default app", handler: "system" },
];
const KNOWN_EXTENSIONS = new Set(GROUPS.flatMap((group) => group.extensions));

/** Global file-opening preferences. State and persistence belong to the open service. */
export function FileOpenSettings() {
  const { locale } = useLocale();
  const label = (zh: string, en: string) => locale.startsWith("zh") ? zh : en;
  const preferences = useFileOpenPreferences();
  const [extension, setExtension] = useState("");
  const [extensionError, setExtensionError] = useState(false);
  const [customHandler, setCustomHandler] = useState<Handler>("taomni");
  const update = setFileOpenPreferences;
  const handlerLabel = (handler: Handler) => ({
    taomni: label("用 Taomni 打开", "Open with Taomni"),
    workspace: label("Code Workspace 编辑器", "Code Workspace editor"),
    system: label("用系统应用打开", "Open with system app"),
  })[handler];
  const updateAssociation = (extensions: string[], handler: string) => {
    const associations = { ...preferences.associations };
    for (const ext of extensions) {
      if (!handler) delete associations[ext];
      else associations[ext] = handler as Handler;
    }
    update({ associations });
  };
  const extras = Object.keys(preferences.associations).filter((ext) => !KNOWN_EXTENSIONS.has(ext)).sort();
  const customExtension = extension.trim().replace(/^\./, "").toLowerCase();
  const addAssociation = () => {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(customExtension)) {
      setExtensionError(true);
      return;
    }
    updateAssociation([customExtension], customHandler);
    setExtension("");
    setExtensionError(false);
  };

  return (
    <section data-testid="file-open-settings" className="mb-5 rounded-lg border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-4 text-[12px]">
      <div className="mb-3 flex items-start gap-2">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--taomni-accent)]" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold">{label("文件与打开方式", "Files and opening")}</h2>
          <p className="mt-1 text-[var(--taomni-text-muted)]">{label(
            "决定在 Taomni 各处（Explorer、终端链接、Workspace、邮件、AI 对话…）打开文件时的默认行为。",
            "Choose the default behavior across Explorer, terminal links, Workspace, mail and AI conversations.",
          )}</p>
        </div>
        <button type="button" data-testid="file-open-settings-reset" className="taomni-btn inline-flex h-7 shrink-0 items-center gap-1" onClick={() => resetFileOpenPreferences()}>
          <RotateCcw className="h-3.5 w-3.5" />{label("恢复默认", "Restore defaults")}
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="w-40">{label("双击文件时", "When double-clicking a file")}</span>
        <div role="radiogroup" aria-label={label("双击文件时", "When double-clicking a file")} className="inline-flex rounded border border-[var(--taomni-divider)]">
          {(["taomni", "system"] as const).map((handler) => (
            <button key={handler} type="button" role="radio" aria-checked={preferences.defaultHandler === handler} data-testid={`file-open-default-${handler}`}
              className="px-3 py-1.5" style={preferences.defaultHandler === handler ? { background: "var(--taomni-selected)", color: "var(--taomni-accent)" } : undefined}
              onClick={() => update({ defaultHandler: handler })}>{handlerLabel(handler)}</button>
          ))}
        </div>
        <span className="text-[var(--taomni-text-muted)]">{label("Ctrl/⌘ + 双击 取另一种", "Ctrl/⌘ + double-click uses the alternative")}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead><tr className="border-b border-[var(--taomni-divider)] text-[var(--taomni-text-muted)]">
            <th className="p-2 font-medium">{label("文件类型", "File type")}</th>
            <th className="p-2 font-medium">{label("默认打开方式", "Default handler")}</th>
          </tr></thead>
          <tbody>
            {GROUPS.map((group) => {
              const overrides = group.extensions.map((ext) => preferences.associations[ext]);
              const uniform = overrides.every((value) => value === overrides[0]);
              const value = uniform ? overrides[0] ?? "" : "mixed";
              const inherited = group.handler === "taomni" && preferences.defaultHandler === "system"
                ? handlerLabel("system") : label(group.zh, group.en);
              return (
                <tr key={group.id} className="border-b border-[var(--taomni-divider)]">
                  <td className="p-2 font-mono text-[11px]">{group.id === "source" ? label("源码文件 (.ts .rs .py …)", "Source files (.ts .rs .py …)") : group.extensions.map((ext) => `.${ext}`).join(" ")}</td>
                  <td className="p-2"><select aria-label={group.extensions.map((ext) => `.${ext}`).join(" ")} data-testid={`file-open-association-${group.id}`} className="taomni-input h-8 w-full min-w-48" value={value} onChange={(event) => updateAssociation(group.extensions, event.target.value)}>
                    <option value="">{inherited} · {label("默认", "Default")}</option>
                    {!uniform && <option value="mixed" disabled>{label("按扩展名分别设置", "Different extension overrides")}</option>}
                    {(["taomni", "workspace", "system"] as const).map((handler) => <option key={handler} value={handler}>{handlerLabel(handler)}</option>)}
                  </select></td>
                </tr>
              );
            })}
            {extras.map((ext) => <tr key={ext} className="border-b border-[var(--taomni-divider)]">
              <td className="p-2 font-mono">.{ext}</td>
              <td className="p-2"><select aria-label={`.${ext}`} data-testid="file-open-association-custom" data-extension={ext} className="taomni-input h-8 w-full" value={preferences.associations[ext]} onChange={(event) => updateAssociation([ext], event.target.value)}>
                <option value="">{label("移除关联（使用默认）", "Remove override (use default)")}</option>
                {(["taomni", "workspace", "system"] as const).map((handler) => <option key={handler} value={handler}>{handlerLabel(handler)}</option>)}
              </select></td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <input data-testid="file-open-extension" aria-label={label("扩展名", "Extension")} placeholder=".jpeg" className="taomni-input h-8 w-32" value={extension} onChange={(event) => { setExtension(event.target.value); setExtensionError(false); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addAssociation(); } }} />
        <select data-testid="file-open-extension-handler" aria-label={label("扩展名打开方式", "Extension handler")} className="taomni-input h-8" value={customHandler} onChange={(event) => setCustomHandler(event.target.value as Handler)}>{(["taomni", "workspace", "system"] as const).map((handler) => <option key={handler} value={handler}>{handlerLabel(handler)}</option>)}</select>
        <button type="button" data-testid="file-open-association-add" className="taomni-btn" onClick={addAssociation}>{label("添加扩展名", "Add extension")}</button>
        {preferences.associations[customExtension] && <button type="button" data-testid="file-open-association-remove" className="taomni-btn" onClick={() => updateAssociation([customExtension], "")}>{label("移除关联", "Remove override")}</button>}
        {extensionError && <span role="alert">{label("请输入有效的文件扩展名", "Enter a valid file extension")}</span>}
      </div>

      <h3 className="mb-3 mt-5 text-[13px] font-semibold">Markdown</h3>
      <div className="grid grid-cols-[minmax(120px,170px)_minmax(0,1fr)] items-center gap-3">
        <label htmlFor="file-open-image-dir">{label("粘贴图片保存到", "Save pasted images to")}</label>
        <div><input id="file-open-image-dir" data-testid="file-open-image-dir" className="taomni-input h-8 w-full max-w-sm" value={preferences.markdownImageDir} onChange={(event) => update({ markdownImageDir: event.target.value })} /><p className="mt-1 text-[var(--taomni-text-muted)]">{label("文档同级 assets/ 文件夹", "assets/ folder next to the document")}</p></div>
        <label htmlFor="file-open-image-template">{label("文件名模板", "File name template")}</label>
        <div><input id="file-open-image-template" data-testid="file-open-image-template" className="taomni-input h-8 w-full max-w-sm font-mono" value={preferences.markdownImageTemplate} onChange={(event) => update({ markdownImageTemplate: event.target.value })} /><p className="mt-1 text-[var(--taomni-text-muted)]">{label("文件名模板 image-{日期}-{时间}.png", "Template image-{date}-{time}.png")}</p></div>
        <span>{label("图片链接", "Image links")}</span><span>{label("相对路径（推荐）", "Relative paths (recommended)")}</span>
        <span>{label("粘贴网页/Excel 表格", "Paste web/Excel tables")}</span>
        <label className="flex items-center gap-2"><input type="checkbox" data-testid="file-open-convert-tables" checked={preferences.convertTables} onChange={(event) => update({ convertTables: event.target.checked })} />{label("自动转为 Markdown 表格", "Convert to Markdown tables automatically")}</label>
      </div>

      <h3 className="mb-3 mt-5 text-[13px] font-semibold">{label("HTML 预览", "HTML preview")}</h3>
      <div className="grid grid-cols-[minmax(120px,170px)_minmax(0,1fr)] items-center gap-3">
        <label htmlFor="file-open-html-network">{label("网络请求", "Network requests")}</label>
        <select id="file-open-html-network" data-testid="file-open-html-network" className="taomni-input h-8 w-full max-w-sm" value={preferences.htmlNetwork} onChange={(event) => update({ htmlNetwork: event.target.value as "block" | "ask" })}>
          <option value="block">{label("默认阻止（每标签可临时允许）", "Block by default (allow per tab temporarily)")}</option>
          <option value="ask">{label("每次询问", "Ask each time")}</option>
        </select>
        <label htmlFor="html-preview-proxy-mode">{label("允许网络时的代理", "Proxy when network is allowed")}</label>
        <select id="html-preview-proxy-mode" data-testid="html-preview-proxy-mode" className="taomni-input h-8 w-full max-w-sm" value={preferences.htmlProxyMode} onChange={(event) => update({ htmlProxyMode: event.target.value as "app" | "custom" | "none" })}>
          <option value="app">{label("使用应用代理（默认）", "Application proxy (default)")}</option>
          <option value="custom">{label("使用独立代理", "Independent proxy")}</option>
          <option value="none">{label("不使用代理（绕过系统代理）", "No proxy (bypass system/environment)")}</option>
        </select>
        {preferences.htmlProxyMode === "custom" && <div className="col-span-2" data-testid="html-preview-custom-proxy-panel"><AppProxyPanel value={preferences.htmlCustomProxy} onSave={async (config) => update({ htmlCustomProxy: config })} /></div>}
        <span className="col-span-2 text-[11px] text-[var(--taomni-text-muted)]">{label("仅本次允许的页面资源通过受限后端通道读取；代理失败不会回落直连。页面不能直接访问网络。", "Allowed page resources use a restricted backend channel. Proxy errors never fall back to direct connections; pages cannot access the network directly.")}</span>
        <span>{label("运行脚本", "Run scripts")}</span>
        <label className="flex items-center gap-2"><input type="checkbox" data-testid="file-open-html-scripts" checked={preferences.htmlScripts} onChange={(event) => update({ htmlScripts: event.target.checked })} />{label("在隔离沙盒中运行", "Run in an isolated sandbox")}</label>
      </div>

      <h3 className="mb-3 mt-5 text-[13px] font-semibold">{label("编辑器偏好", "Editor preferences")}</h3>
      <div className="flex flex-wrap items-center gap-5">
        <label className="flex items-center gap-2"><input type="checkbox" data-testid="file-open-wrap" checked={preferences.wrap} onChange={(event) => update({ wrap: event.target.checked })} />{label("自动换行", "Word wrap")}</label>
        <label className="flex items-center gap-2">{label("字号", "Font size")}<input type="number" min={10} max={32} id="file-open-font-size" data-testid="file-open-font-size" className="taomni-input h-8 w-20" value={preferences.fontSize} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 10 && value <= 32) update({ fontSize: value }); }} /></label>
      </div>
    </section>
  );
}
