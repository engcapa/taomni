import { classifyFile, editableFileExtensions, editableFileNames } from "../../lib/openFile/classifyFile";

type Label = (zh: string, en: string) => string;
export interface NewFileType { id: string; title: string; name: string; group: string }

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
