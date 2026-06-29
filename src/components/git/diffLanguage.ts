import type { Extension } from "@codemirror/state";

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
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "ts":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });
    case "json":
    case "jsonc":
      return (await import("@codemirror/lang-json")).json();
    case "py":
    case "pyi":
      return (await import("@codemirror/lang-python")).python();
    case "rs":
      return (await import("@codemirror/lang-rust")).rust();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "css":
    case "scss":
    case "less":
      return (await import("@codemirror/lang-css")).css();
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return (await import("@codemirror/lang-html")).html();
    case "md":
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "xml":
    case "svg":
    case "xaml":
    case "plist":
      return (await import("@codemirror/lang-xml")).xml();
    case "yaml":
    case "yml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hxx":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "php":
      return (await import("@codemirror/lang-php")).php();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    default:
      return null;
  }
}
