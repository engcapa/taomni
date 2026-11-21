import { classifyFile, editableFileExtensions, editableFileNames } from "../../lib/openFile/classifyFile";

type Label = (zh: string, en: string) => string;
export interface NewFileType { id: string; title: string; name: string; group: string }

export const EXPLORER_TEXT_FILE_TYPES = [
  { extension: "txt", zh: "文本文档 (.txt)", en: "Text document (.txt)", name: ["新建文本文档", "New text document"] },
  { extension: "md", zh: "Markdown 文档 (.md)", en: "Markdown document (.md)", name: ["新建 Markdown 文档", "New Markdown document"] },
  { extension: "html", zh: "HTML 文档 (.html)", en: "HTML document (.html)", name: ["新建 HTML 文档", "New HTML document"] },
  { extension: "css", zh: "CSS 文档 (.css)", en: "CSS document (.css)", name: ["新建 CSS 文档", "New CSS document"] },
  { extension: "js", zh: "JavaScript 文件 (.js)", en: "JavaScript file (.js)", name: ["新建 JavaScript 文件", "New JavaScript file"] },
  { extension: "ts", zh: "TypeScript 文件 (.ts)", en: "TypeScript file (.ts)", name: ["新建 TypeScript 文件", "New TypeScript file"] },
  { extension: "json", zh: "JSON 文档 (.json)", en: "JSON document (.json)", name: ["新建 JSON 文档", "New JSON document"] },
] as const;
export type ExplorerQuickExtension = (typeof EXPLORER_TEXT_FILE_TYPES)[number]["extension"];

export function explorerFileTypes(label: Label): NewFileType[] {
  const groups = {
    text: label("文本与配置", "Text and configuration"),
    source: label("源代码", "Source code"),
    markdown: "Markdown", html: "HTML", svg: "SVG",
  };
  const common = ["txt", "md", "html", "svg", "json", "yaml", "xml", "csv"];
  const extensions = [...common, ...editableFileExtensions.filter((ext) => !common.includes(ext))];
  return [
    ...extensions.map((extension) => {
      const kind = classifyFile(`file.${extension}`) as keyof typeof groups;
      const title = extension === "txt" ? label("文本文件", "Text file") : extension.toUpperCase();
      const dotfile = ["env", "gitignore", "gitattributes", "editorconfig", "dockerignore"].includes(extension);
      return { id: extension, title: `${title} (.${extension})`,
        name: dotfile ? `.${extension}` : `${label("新建文件", "New file")}.${extension}`, group: groups[kind] };
    }),
    ...editableFileNames.map((name) => ({ id: `name:${name}`, title: name, name,
      group: classifyFile(name) === "source" ? groups.source : groups.text })),
  ];
}

export function uniqueNewFileName(name: string, existing: readonly string[]): string {
  const names = new Set(existing.map((value) => value.toLowerCase()));
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : dot === 0 ? "file" : name;
  const suffix = dot >= 0 ? name.slice(dot) : "";
  let candidate = name;
  let index = 2;
  while (names.has(candidate.toLowerCase())) candidate = `${base} (${index++})${suffix}`;
  // Conventional names such as Dockerfile have no equivalent numbered name.
  // Keep that name and let exclusive creation report the conflict explicitly.
  const kind = classifyFile(name);
  if (kind !== "binary" && classifyFile(candidate) !== kind) return name;
  return candidate;
}

export function newFileNameError(name: string, label: Label): string | null {
  if (!name.trim() || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    return label("请输入当前目录下的有效文件名", "Enter a valid file name in the current folder");
  }
  if (["binary", "image", "pdf"].includes(classifyFile(name))) {
    return label("请选择 Taomni 支持编辑的文件类型或扩展名", "Choose a file type or extension Taomni can edit");
  }
  return null;
}
