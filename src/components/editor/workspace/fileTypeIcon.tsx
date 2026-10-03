import { File } from "lucide-react";

/**
 * IDEA-style editor-tab file type badge (ED-PARITY-011 DEC-011-05): a small
 * letter glyph per language family, falling back to the generic file icon.
 */
const BADGES: Record<string, { label: string; className: string; title: string }> = {
  java: { label: "C", className: "bg-sky-500/15 text-sky-500", title: "Java" },
  kt: { label: "K", className: "bg-violet-500/15 text-violet-500", title: "Kotlin" },
  kts: { label: "K", className: "bg-violet-500/15 text-violet-500", title: "Kotlin script" },
  ts: { label: "TS", className: "bg-blue-500/15 text-blue-500", title: "TypeScript" },
  tsx: { label: "TS", className: "bg-blue-500/15 text-blue-500", title: "TypeScript JSX" },
  js: { label: "JS", className: "bg-amber-500/15 text-amber-600", title: "JavaScript" },
  jsx: { label: "JS", className: "bg-amber-500/15 text-amber-600", title: "JavaScript JSX" },
  json: { label: "{}", className: "bg-emerald-500/15 text-emerald-600", title: "JSON" },
  md: { label: "M↓", className: "bg-slate-500/15 text-slate-500", title: "Markdown" },
  py: { label: "Py", className: "bg-yellow-500/15 text-yellow-600", title: "Python" },
  rs: { label: "Rs", className: "bg-orange-500/15 text-orange-600", title: "Rust" },
  go: { label: "Go", className: "bg-cyan-500/15 text-cyan-600", title: "Go" },
  xml: { label: "<>", className: "bg-orange-500/15 text-orange-600", title: "XML" },
  yaml: { label: "Y", className: "bg-rose-500/15 text-rose-500", title: "YAML" },
  yml: { label: "Y", className: "bg-rose-500/15 text-rose-500", title: "YAML" },
  sql: { label: "SQL", className: "bg-indigo-500/15 text-indigo-500", title: "SQL" },
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
      className={`inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-sm px-0.5 text-[8px] font-bold leading-none ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}
