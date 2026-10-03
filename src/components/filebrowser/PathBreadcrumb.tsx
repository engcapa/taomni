import { useMemo, useState, useEffect } from "react";
import { ChevronRight, Home, HardDrive, Pencil } from "lucide-react";
import { useT } from "../../lib/i18n";
import { cleanPathInput, isWindowsPath } from "../../lib/pathCompletion";
import type { FileEntry } from "../../lib/sftp";
import { PathCompletionInput } from "./PathCompletionInput";

interface PathBreadcrumbProps {
  path: string;
  homePath?: string | null;
  onNavigate: (path: string) => void;
  onSubmit?: (path: string) => void;
  detectWindows?: boolean;
  testId?: string;
  listDirectory?: (path: string) => Promise<FileEntry[]>;
  showHidden?: boolean;
}

export function PathBreadcrumb({
  path,
  homePath,
  onNavigate,
  onSubmit,
  detectWindows,
  testId,
  listDirectory,
  showHidden,
}: PathBreadcrumbProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(path);

  useEffect(() => {
    if (!editing) setEditValue(path);
  }, [path, editing]);

  const isDrivesRoot = path === "\\\\";
  const isWindows = detectWindows ?? isWindowsPath(path);
  const sep = isWindows ? "\\" : "/";

  const segments = useMemo(() => {
    if (!path) return [];
    if (path === "/") return [{ label: "/", path: "/" }];
    if (isDrivesRoot) return [{ label: t("fileBrowser.pathBreadcrumbDrives"), path: "\\\\" }];
    if (isWindows) {
      const drive = path.match(/^([A-Z]):/i)?.[1];
      const normalized = path.replace(/\//g, "\\");
      const rest = normalized.slice(drive ? 2 : 0).replace(/\\$/, "");
      const parts = rest.split("\\").filter(Boolean);
      const result: { label: string; path: string }[] = [];
      if (drive) result.push({ label: `${drive.toUpperCase()}:`, path: `${drive.toUpperCase()}:\\` });
      let acc = drive ? `${drive.toUpperCase()}:` : normalized.startsWith("\\\\") ? "\\" : "";
      for (const part of parts) {
        acc = acc ? `${acc}\\${part}` : part;
        result.push({ label: part, path: acc });
      }
      return result;
    }
    const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
    const result: { label: string; path: string }[] = [{ label: "/", path: "/" }];
    let acc = "";
    for (const part of parts) {
      acc = `${acc}/${part}`;
      result.push({ label: part, path: acc });
    }
    return result;
  }, [path, isWindows, isDrivesRoot, t]);

  const handleEnter = (value: string) => {
    setEditing(false);
    const cleaned = cleanPathInput(value);
    if (cleaned && cleaned !== path) {
      onSubmit?.(cleaned);
    }
  };

  if (editing) {
    return (
      <PathCompletionInput
        path={path}
        testId={testId}
        value={editValue}
        onChange={setEditValue}
        onCommit={handleEnter}
        onCancel={() => {
          setEditValue(path);
          setEditing(false);
        }}
        listDirectory={listDirectory}
        homePath={homePath}
        detectWindows={detectWindows}
        showHidden={showHidden}
      />
    );
  }

  return (
    <div
      data-testid={testId}
      className="taomni-path-breadcrumb flex-1 min-w-0 h-full flex items-center gap-0.5 px-1.5 overflow-hidden text-[12px] leading-none cursor-text"
      style={{ background: "var(--taomni-input-bg)", border: "1px solid var(--taomni-input-border)", borderRadius: 2 }}
      onClick={() => setEditing(true)}
      onContextMenu={(e) => {
        e.preventDefault();
        navigator.clipboard?.writeText(path).catch(() => {});
      }}
      title={t("fileBrowser.pathBreadcrumbEditTitle")}
    >
      <span
        data-testid={testId ? `${testId}-segments` : undefined}
        className="taomni-path-breadcrumb-scroll flex-1 self-stretch flex items-center gap-0.5 min-w-0 overflow-x-auto overflow-y-hidden"
      >
        {homePath && homePath !== path && (
          <button
            type="button"
            className="px-1 hover:bg-[var(--taomni-hover)] rounded shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate(homePath);
            }}
            title={t("fileBrowser.pathBreadcrumbHome")}
          >
            <Home className="w-3 h-3" />
          </button>
        )}
        {isWindows && !isDrivesRoot && (
          <button
            type="button"
            data-testid="breadcrumb-drives-root"
            className="px-1 hover:bg-[var(--taomni-hover)] rounded shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate("\\\\");
            }}
            title={t("fileBrowser.pathBreadcrumbShowDrives")}
          >
            <HardDrive className="w-3 h-3" />
          </button>
        )}
        {segments.map((seg, i) => (
          <span key={`${seg.path}-${i}`} className="flex items-center shrink-0">
            {i > 0 && <ChevronRight className="w-3 h-3 opacity-50" />}
            <button
              type="button"
              data-path={seg.path}
              className="px-1 hover:bg-[var(--taomni-hover)] rounded shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onNavigate(seg.path);
              }}
            >
              {seg.label || sep}
            </button>
        </span>
      ))}
      </span>
      <button
        type="button"
        data-testid={testId ? `${testId}-edit` : undefined}
        aria-label={t("fileBrowser.pathBreadcrumbEditTitle")}
        title={t("fileBrowser.pathBreadcrumbEditTitle")}
        className="ml-auto px-1 shrink-0 hover:bg-[var(--taomni-hover)] rounded"
        onClick={(e) => {
          e.stopPropagation();
          setEditValue(path);
          setEditing(true);
        }}
      >
        <Pencil className="w-3 h-3" />
      </button>
    </div>
  );
}
