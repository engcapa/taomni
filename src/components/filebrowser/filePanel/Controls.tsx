import { ChevronDown, File as FileIcon, Folder, HardDrive, HelpCircle, Link as LinkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useT } from "../../../lib/i18n";
import { sftpLocalDrives, type DriveEntry, type FileEntry } from "../../../lib/sftp";

export function SortHeader({
  label,
  active,
  dir,
  onClick,
  className,
  onResizeStart,
  onResizeReset,
  hint,
  resizeTitle,
  testKey,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  className?: string;
  /** When set, renders a 4-px drag handle on the right edge that resizes
   *  the *next* column. Omit on the last column. */
  onResizeStart?: (e: MouseEvent) => void;
  /** Double-clicking the handle resets the affected column to its default. */
  onResizeReset?: () => void;
  /** Optional help text shown via a small "?" icon next to the label. */
  hint?: string;
  /** Tooltip shown on the resize handle. */
  resizeTitle?: string;
  /** Stable key used for data-testid attributes (independent of localized label). */
  testKey?: string;
}) {
  const slug = (testKey ?? label).toLowerCase();
  return (
    <th
      data-testid={`col-header-${slug}`}
      className={`text-left px-1.5 py-0.5 cursor-pointer select-none border-b relative ${className ?? ""}`}
      style={{ borderColor: "var(--taomni-divider)" }}
      onClick={onClick}
    >
      <span className="truncate inline-block align-bottom max-w-full">
        {label} {active ? (dir === "asc" ? "▲" : "▼") : ""}
      </span>
      {hint && (
        <span
          aria-label={hint}
          data-testid={`col-header-${slug}-hint`}
          title={hint}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex align-middle ml-1 opacity-60 hover:opacity-100 cursor-help"
        >
          <HelpCircle className="w-3 h-3" />
        </span>
      )}
      {onResizeStart && (
        <span
          role="separator"
          aria-orientation="vertical"
          data-testid={`col-resize-${slug}`}
          title={resizeTitle ?? "Drag to resize next column • double-click to reset"}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={onResizeStart}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onResizeReset?.();
          }}
          className="absolute top-0 right-0 h-full w-[5px] cursor-col-resize hover:bg-[var(--taomni-accent)]"
          style={{ zIndex: 1 }}
        />
      )}
    </th>
  );
}

export function DrivesPicker({ onSelect }: { onSelect: (path: string) => void; }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [drives, setDrives] = useState<DriveEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await sftpLocalDrives();
      setDrives(list);
    } catch {
      setDrives([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!drives) void refresh();
    const onDoc = (e: globalThis.MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open, drives, refresh]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        title={t("fileBrowser.drivesSwitchTitle")}
        className="h-5 px-1 inline-flex items-center gap-0.5 rounded hover:bg-[var(--taomni-hover)] text-[11px]"
        onClick={() => setOpen((v) => !v)}
        style={{ color: "var(--taomni-text-muted)" }}
      >
        <HardDrive className="w-3 h-3" />
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-0.5 z-50 min-w-[160px] py-1 text-[12px] shadow-lg rounded"
          style={{
            background: "var(--taomni-bg)",
            border: "1px solid var(--taomni-divider)",
            color: "var(--taomni-text)",
          }}
        >
          {loading && (
            <div className="px-2 py-1 text-[var(--taomni-text-muted)]">{t("fileBrowser.drivesLoading")}</div>
          )}
          {!loading && drives && drives.length === 0 && (
            <div className="px-2 py-1 text-[var(--taomni-text-muted)]">
              {t("fileBrowser.drivesNoneReported")}
            </div>
          )}
          {!loading &&
            drives?.map((d) => (
              <button
                key={d.id}
                type="button"
                className="w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)] flex items-center gap-1.5"
                onClick={() => {
                  onSelect(d.path);
                  setOpen(false);
                }}
                title={d.path}
              >
                <HardDrive className="w-3 h-3 shrink-0" />
                <span className="truncate">{d.label}</span>
                <span
                  className="ml-auto text-[10px]"
                  style={{ color: "var(--taomni-text-muted)" }}
                >
                  {d.path}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export function FileTypeIcon({ entry }: { entry: FileEntry; }) {
  if (entry.fileType === "dir") return <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: "#dab760" }} />;
  if (entry.fileType === "symlink") return <LinkIcon className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--taomni-accent)" }} />;
  return <FileIcon className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--taomni-text-muted)" }} />;
}
