import type { FileEntry } from "../../lib/sftp";

const colors: Record<string, string> = {
  ts: "#3178c6", tsx: "#3178c6", js: "#d4a017", json: "#8b7a2b", md: "#64748b",
  rs: "#c2410c", toml: "#9a3412", txt: "#64748b", png: "#16a34a", jpg: "#16a34a",
  svg: "#9333ea", pdf: "#dc2626", docx: "#2563eb", xlsx: "#15803d", csv: "#15803d",
  zip: "#a16207", gz: "#a16207", sh: "#0d9488",
};
export function ExplorerFileIcon({ entry, name = "", directory = false, className }: {
  entry?: FileEntry; name?: string; directory?: boolean; className?: string;
}) {
  const folder = directory || entry?.fileType === "dir" || entry?.targetFileType === "dir";
  const filename = entry?.name ?? name;
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : "";
  return <svg className={className ?? "ex-file-icon"} viewBox="0 0 24 24" aria-hidden="true">
    {folder ? <>
      <path d="M3 6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.5.7L12 6h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="var(--ex-folder)" />
      <path d="M3 9.5h18V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="var(--ex-folder)" opacity=".78" />
    </> : <>
      <path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="var(--ex-card)" stroke="var(--ex-input-b)" strokeWidth="1" />
      <path d="M14 2v5h5" fill="var(--ex-hover2)" stroke="var(--ex-input-b)" strokeWidth="1" />
      <rect x="4" y="12.5" width="15" height="6" rx="1.5" fill={colors[extension] ?? "#64748b"} />
      <text x="11.5" y="17" fontSize="4.3" fontWeight="700" fill="#fff" textAnchor="middle" fontFamily="sans-serif">{extension.slice(0, 4).toUpperCase()}</text>
    </>}
    {entry?.fileType === "symlink" && <path d="M2 22h6v-4M2 22l6-6" fill="none" stroke="var(--ex-accent)" strokeWidth="1.5" />}
  </svg>;
}
