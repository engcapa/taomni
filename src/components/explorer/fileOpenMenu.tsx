import { Braces, Check, ExternalLink, FileText, Monitor, Pencil } from "lucide-react";
import { openFile, classifyFile, fileExtension, supportsFileViewer, type OpenFileMode } from "../../lib/openFile";
import { documentProvider } from "../../lib/openFile/documentProvider";
import { setFileOpenPreferences, useFileOpenPreferences } from "../../lib/openFile/preferences";
import type { MenuItem } from "../ContextMenu";

type Label = (zh: string, en: string) => string;
export function fileOpenMenu(
  path: string,
  workspaceId: string | undefined,
  label: Label,
  onError: (message: string, error?: unknown) => void,
): MenuItem[] {
  const kind = classifyFile(path);
  const supported = supportsFileViewer(kind);
  const office = documentProvider(path);
  const run = (mode: OpenFileMode) => {
    void openFile({ path }, { context: "explorer", workspaceId, mode }).catch((error) => onError(String(error), error));
  };
  const names: Record<string, string> = {
    image: label("图片查看器", "Image viewer"),
    svg: label("SVG 查看器", "SVG viewer"),
    text: "Notepad",
    markdown: label("Markdown 编辑器", "Markdown editor"),
    html: label("HTML 预览", "HTML preview"),
  };
  const prefs = useFileOpenPreferences.getState();
  const extension = fileExtension(path);
  return [
    ...(supported && !office ? [{
      label: kind === "text" ? "Taomni Notepad" : `Taomni ${names[kind]}`,
      icon: <ExternalLink />,
      testId: "file-open-with-taomni",
      onClick: () => run("taomni"),
    }] : []),
    ...(["svg", "markdown", "html"].includes(kind) ? [{
      label: label("Notepad 打开源码", "Notepad (source)"),
      icon: <Pencil />,
      testId: "file-open-with-source",
      onClick: () => run("source"),
    }] : kind !== "text" ? [{
      label: label("Notepad 打开", "Open in Notepad"),
      icon: <Pencil />,
      testId: "file-open-with-notepad",
      onClick: () => run("notepad"),
    }] : []),
    {
      label: label("Code editor (Code Workspace)", "Code editor (Code Workspace)"),
      icon: <Braces />,
      testId: "file-open-with-workspace",
      disabled: !!office || (!supported && kind !== "source"),
      onClick: () => run("workspace"),
    },
    ...(office ? [{
      label: `TaOffice · ${office.name}`,
      icon: <FileText />,
      testId: "file-open-with-taoffice",
      onClick: () => run("taoffice"),
    }] : []),
    { label: "", separator: true },
    {
      label: label("系统默认应用", "System default app"),
      icon: <Monitor />,
      testId: "file-open-with-system",
      onClick: () => run("system"),
    },
    ...(extension && (supported || office || kind === "source") ? [
      { label: "", separator: true },
      ...(office ? [{
        label: label(`始终使用 TaOffice 打开 .${extension}`, `Always open .${extension} with TaOffice`),
        checked: prefs.associations[extension] === "taoffice",
        testId: "file-open-with-remember-taoffice",
        onClick: () => setFileOpenPreferences({ associations: { ...prefs.associations, [extension]: "taoffice" } }),
      }] : supported ? [{
        label: label(
          `记住：.${extension} 始终用 ${kind === "text" ? "Notepad" : "Taomni"} 打开`,
          `Always open .${extension} with ${kind === "text" ? "Notepad" : "Taomni"}`,
        ),
        icon: <Check />,
        checked: prefs.associations[extension] === "taomni" || prefs.associations[extension] === "notepad",
        testId: "file-open-with-remember",
        onClick: () => setFileOpenPreferences({
          associations: { ...prefs.associations, [extension]: kind === "text" ? "notepad" : "taomni" },
        }),
      }] : [{
        label: label(`记住：.${extension} 始终用 Notepad 打开`, `Always open .${extension} with Notepad`),
        icon: <Check />,
        checked: prefs.associations[extension] === "notepad",
        testId: "file-open-with-remember-notepad",
        onClick: () => setFileOpenPreferences({ associations: { ...prefs.associations, [extension]: "notepad" } }),
      }]),
      {
        label: label(`记住：.${extension} 始终用系统应用打开`, `Always open .${extension} with system app`),
        checked: prefs.associations[extension] === "system",
        testId: "file-open-with-remember-system",
        onClick: () => setFileOpenPreferences({ associations: { ...prefs.associations, [extension]: "system" } }),
      },
    ] : []),
  ];
}
