import { officialDocumentFormats } from "./documentFormats";

export type FileKind = "image" | "svg" | "text" | "markdown" | "html" | "pdf" | "document" | "archive" | "source" | "binary";

const images = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tif", "tiff"]);
const text = new Set(["txt", "text", "log", "ini", "conf", "config", "env", "json", "jsonc", "yaml", "yml", "toml", "xml", "csv", "tsv", "properties", "gitignore", "gitattributes", "editorconfig", "dockerignore"]);
const source = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "pyi", "go", "java", "kt", "kts", "c", "h", "cc", "cpp", "hpp", "cs", "swift", "m", "mm", "php", "rb", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "css", "scss", "less", "sass", "vue", "svelte", "gradle", "cmake", "make"]);
const textNames = new Set(["readme", "license", "licence", "copying", "changelog", "authors"]);
const sourceNames = new Set(["makefile", "dockerfile", "gemfile", "procfile", "cmakelists.txt"]);

// Creation and opening share this inventory so preview-only formats never
// appear as editable new-file types and aliases remain available.
export const editableFileExtensions: readonly string[] = [...text, ...source, "md", "markdown", "mdown", "html", "htm", "svg"];
export const editableFileNames: readonly string[] = [...textNames, ...sourceNames];

export function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
}
export function classifyFile(path: string): FileKind {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const extension = fileExtension(path);
  if (images.has(extension)) return "image";
  if (extension === "svg") return "svg";
  if (extension === "md" || extension === "markdown" || extension === "mdown") return "markdown";
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "pdf") return "pdf";
  if (extension === "zip" || extension === "cbz") return "archive";
  if (officialDocumentFormats.has(extension)) return "document";
  if (sourceNames.has(name) || source.has(extension)) return "source";
  if (textNames.has(name) || text.has(extension) || name.startsWith(".env.")) return "text";
  return "binary";
}
export function supportsFileViewer(kind: FileKind): boolean {
  return ["image", "svg", "text", "markdown", "html", "pdf", "document", "archive"].includes(kind);
}
