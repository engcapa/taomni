import type { Extension } from "@codemirror/state";

// Keys below are a fixed set of grammar configurations, never file paths.
// Reusing LanguageSupport also avoids reconfiguring a cached editor document
// simply because the same grammar was resolved for another tab or diff view.
const languages = new Map<string, Promise<Extension>>();
function cachedLanguage(key: string, load: () => Promise<Extension>): Promise<Extension> {
  const previous = languages.get(key);
  if (previous) return previous;
  const pending = load().catch((error) => {
    if (languages.get(key) === pending) languages.delete(key);
    throw error;
  });
  languages.set(key, pending);
  return pending;
}

// Lazily resolve a CodeMirror language extension for a file path. Each language
// package is dynamically imported so the diff viewer only pulls in the grammar it
// actually needs. Unknown extensions fall back to plain text (null).
export async function languageForPath(path: string | null | undefined): Promise<Extension | null> {
  const name = (path ?? "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return cachedLanguage("javascript:{ jsx: true }", async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }));
    case "ts":
      return cachedLanguage("javascript:{ typescript: true }", async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }));
    case "tsx":
      return cachedLanguage("javascript:{ jsx: true, typescript: true }", async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }));
    case "json":
    case "jsonc":
      return cachedLanguage("json", async () => (await import("@codemirror/lang-json")).json());
    case "py":
    case "pyi":
      return cachedLanguage("python", async () => (await import("@codemirror/lang-python")).python());
    case "rs":
      return cachedLanguage("rust", async () => (await import("@codemirror/lang-rust")).rust());
    case "java":
      return cachedLanguage("java", async () => (await import("@codemirror/lang-java")).java());
    case "go":
      return cachedLanguage("go", async () => (await import("@codemirror/lang-go")).go());
    case "css":
    case "scss":
    case "less":
      return cachedLanguage("css", async () => (await import("@codemirror/lang-css")).css());
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return cachedLanguage("html", async () => (await import("@codemirror/lang-html")).html());
    case "md":
    case "markdown":
      return cachedLanguage("markdown", async () => (await import("@codemirror/lang-markdown")).markdown());
    case "xml":
    case "svg":
    case "xaml":
    case "plist":
      return cachedLanguage("xml", async () => (await import("@codemirror/lang-xml")).xml());
    case "yaml":
    case "yml":
      return cachedLanguage("yaml", async () => (await import("@codemirror/lang-yaml")).yaml());
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hxx":
      return cachedLanguage("cpp", async () => (await import("@codemirror/lang-cpp")).cpp());
    case "php":
      return cachedLanguage("php", async () => (await import("@codemirror/lang-php")).php());
    case "sql":
      return cachedLanguage("sql", async () => (await import("@codemirror/lang-sql")).sql());
    default:
      return null;
  }
}
