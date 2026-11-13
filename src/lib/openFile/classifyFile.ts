export type FileKind = "image" | "svg" | "text" | "markdown" | "html" | "pdf" | "source" | "binary";

const images = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
const text = new Set(["txt", "text", "log", "ini", "conf", "config", "env", "json", "jsonc", "yaml", "yml", "toml", "xml", "csv", "tsv", "properties", "gitignore", "gitattributes", "editorconfig", "dockerignore"]);
const source = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "pyi", "go", "java", "kt", "kts", "c", "h", "cc", "cpp", "hpp", "cs", "swift", "m", "mm", "php", "rb", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "css", "scss", "less", "sass", "vue", "svelte", "gradle", "cmake", "make"]);
const textNames = new Set(["readme", "license", "licence", "copying", "changelog", "authors"]);
const sourceNames = new Set(["makefile", "dockerfile", "gemfile", "procfile", "cmakelists.txt"]);

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
  if (sourceNames.has(name) || source.has(extension)) return "source";
  if (textNames.has(name) || text.has(extension) || name.startsWith(".env.")) return "text";
  return "binary";
}
export function supportsFileViewer(kind: FileKind): boolean {
  return ["image", "svg", "text", "markdown", "html"].includes(kind);
}
