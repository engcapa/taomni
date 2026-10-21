import { type ReactNode } from "react";
import type { GitBlobPair } from "../../../lib/git";
import { formatBytes } from "./complexity";


export function imageDataUrl(path: string, b64: string | null): string | null {
  if (!b64) return null;
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const mime =
    ext === "svg" ? "image/svg+xml" : ext === "ico" ? "image/x-icon" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  return `data:${mime};base64,${b64}`;
}


export function DiffNotice({ text, children, path }: { text: string; children?: ReactNode; path?: string }) {
  return (
    <div
      data-testid={path ? "git-diff-viewer" : undefined}
      data-path={path}
      className="h-full min-h-24 flex flex-col items-center justify-center px-4 text-center text-[12px] text-[var(--taomni-text-muted)]"
    >
      <div>{text}</div>
      {children}
    </div>
  );
}


export function ImageDiff({ pair }: { pair: GitBlobPair }) {
  const oldUrl = imageDataUrl(pair.oldPath ?? pair.path, pair.oldImageB64);
  const newUrl = imageDataUrl(pair.path, pair.newImageB64);
  return (
    <div className="h-full min-h-0 grid grid-cols-2 gap-2 p-3 overflow-auto bg-[var(--taomni-term-bg,#111827)]">
      <ImageSide label={`Before · ${formatBytes(pair.oldSize)}`} url={oldUrl} missing="Not present" />
      <ImageSide label={`After · ${formatBytes(pair.newSize)}`} url={newUrl} missing="Deleted" />
    </div>
  );
}


export function ImageSide({ label, url, missing }: { label: string; url: string | null; missing: string }) {
  return (
    <div className="min-w-0 flex flex-col items-center gap-2">
      <div className="text-[11px] text-slate-300">{label}</div>
      {url ? (
        <img src={url} alt={label} className="max-w-full object-contain border border-[var(--taomni-divider)]" />
      ) : (
        <div className="flex-1 flex items-center justify-center text-[12px] text-slate-400">{missing}</div>
      )}
    </div>
  );
}
