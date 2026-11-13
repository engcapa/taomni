import { Braces, Check, ExternalLink, Monitor, Pencil } from "lucide-react";
import { openFile, classifyFile, fileExtension, supportsFileViewer } from "../../lib/openFile";
import { setFileOpenPreferences, useFileOpenPreferences } from "../../lib/openFile/preferences";
import type { MenuItem } from "../ContextMenu";

type Label = (zh: string, en: string) => string;
export function fileOpenMenu(path: string, workspaceId: string | undefined, label: Label, onError: (message: string) => void): MenuItem[] {
  const kind = classifyFile(path);
  const supported = supportsFileViewer(kind);
  const run = (mode: "taomni" | "source" | "workspace" | "system") => {
    void openFile({ path }, { context: "explorer", workspaceId, mode }).catch((error) => onError(String(error)));
  };
  const names: Record<string, string> = { image: label("图片查看器", "Image viewer"), svg: label("SVG 查看器", "SVG viewer"),
    text: label("文本编辑器", "Text editor"), markdown: label("Markdown 编辑器", "Markdown editor"), html: label("HTML 预览", "HTML preview") };
  const prefs = useFileOpenPreferences.getState();
  const extension = fileExtension(path);
  return [
    ...(supported ? [{ label: `Taomni ${names[kind]}`, icon: <ExternalLink />, testId: "file-open-with-taomni", onClick: () => run("taomni") }] : []),
    ...(["svg", "markdown", "html"].includes(kind) ? [{ label: label("Taomni 文本编辑器（源码）", "Taomni text editor (source)"), icon: <Pencil />, testId: "file-open-with-source", onClick: () => run("source") }] : []),
    { label: label("在 Code Workspace 中打开", "Open in Code Workspace"), icon: <Braces />, testId: "file-open-with-workspace", disabled: !supported && kind !== "source", onClick: () => run("workspace") },
    { label: "", separator: true },
    { label: label("系统默认应用", "System default app"), icon: <Monitor />, testId: "file-open-with-system", onClick: () => run("system") },
    ...(extension && supported ? [
      { label: "", separator: true },
      { label: label(`记住：.${extension} 始终用 Taomni 打开`, `Always open .${extension} with Taomni`), icon: <Check />, checked: prefs.associations[extension] === "taomni", testId: "file-open-with-remember", onClick: () => setFileOpenPreferences({ associations: { ...prefs.associations, [extension]: "taomni" } }) },
      { label: label(`记住：.${extension} 始终用系统应用打开`, `Always open .${extension} with system app`), checked: prefs.associations[extension] === "system", testId: "file-open-with-remember-system", onClick: () => setFileOpenPreferences({ associations: { ...prefs.associations, [extension]: "system" } }) },
    ] : []),
  ];
}
