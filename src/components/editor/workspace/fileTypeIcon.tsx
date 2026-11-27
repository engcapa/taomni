import { File } from "lucide-react";

/**
 * IDEA-style editor-tab file type badge (ED-PARITY-011 DEC-011-05): a small
 * letter glyph per language family, falling back to the generic file icon.
 */
const BADGES: Record<string, { label: string; className: string; title: string }> = {
  java: { label: "C", className: "text-[var(--taomni-code-syntax-function)]", title: "Java" },
  kt: { label: "K", className: "text-[var(--taomni-code-syntax-property)]", title: "Kotlin" },
  kts: { label: "K", className: "text-[var(--taomni-code-syntax-property)]", title: "Kotlin script" },
  ts: { label: "TS", className: "text-[var(--taomni-code-syntax-heading)]", title: "TypeScript" },
  tsx: { label: "TS", className: "text-[var(--taomni-code-syntax-heading)]", title: "TypeScript JSX" },
  js: { label: "JS", className: "text-[var(--taomni-code-syntax-atom)]", title: "JavaScript" },
  jsx: { label: "JS", className: "text-[var(--taomni-code-syntax-atom)]", title: "JavaScript JSX" },
  json: { label: "{}", className: "text-[var(--taomni-code-syntax-type)]", title: "JSON" },
  md: { label: "M↓", className: "text-[var(--taomni-code-syntax-variable)]", title: "Markdown" },
  py: { label: "Py", className: "text-[var(--taomni-code-syntax-number)]", title: "Python" },
  rs: { label: "Rs", className: "text-[var(--taomni-code-syntax-keyword)]", title: "Rust" },
  go: { label: "Go", className: "text-[var(--taomni-code-syntax-function)]", title: "Go" },
  xml: { label: "<>", className: "text-[var(--taomni-code-syntax-keyword)]", title: "XML" },
  yaml: { label: "Y", className: "text-[var(--taomni-code-syntax-escape)]", title: "YAML" },
  yml: { label: "Y", className: "text-[var(--taomni-code-syntax-escape)]", title: "YAML" },
  sql: { label: "SQL", className: "text-[var(--taomni-code-syntax-property)]", title: "SQL" },
};

export function fileTypeKey(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function FileTypeIcon({ path }: { path: string }) {
  const badge = BADGES[fileTypeKey(path)];
  if (!badge) {
    return <File data-file-type="generic" className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />;
  }
  return (
    <span
      data-file-type={fileTypeKey(path)}
      title={badge.title}
      aria-hidden="true"
      className={`inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-sm bg-[var(--taomni-code-bg)] px-0.5 text-ui-caption font-bold leading-none ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}
