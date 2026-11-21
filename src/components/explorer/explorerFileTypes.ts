export interface ExplorerTextFileType {
  extension: "txt" | "md" | "html" | "css" | "js" | "ts" | "json";
  zh: string;
  en: string;
}

export const EXPLORER_TEXT_FILE_TYPES: readonly ExplorerTextFileType[] = [
  { extension: "txt", zh: "文本文档 (.txt)", en: "Text document (.txt)" },
  { extension: "md", zh: "Markdown 文档 (.md)", en: "Markdown document (.md)" },
  { extension: "html", zh: "HTML 文档 (.html)", en: "HTML document (.html)" },
  { extension: "css", zh: "CSS 文档 (.css)", en: "CSS document (.css)" },
  { extension: "js", zh: "JavaScript 文件 (.js)", en: "JavaScript file (.js)" },
  { extension: "ts", zh: "TypeScript 文件 (.ts)", en: "TypeScript file (.ts)" },
  { extension: "json", zh: "JSON 文档 (.json)", en: "JSON document (.json)" },
];
