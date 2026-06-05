/**
 * PathMappingsEditor — A UI component for managing SFTP deployment path
 * mappings (local path ↔ remote path pairs), inspired by JetBrains IDE's
 * Deployment → Mappings configuration.
 *
 * Used in two places:
 *  1. SessionEditor (for persisting mappings to options_json)
 *  2. FileBrowser toolbar (for runtime view/edit of the active session's mappings)
 */
import { useState, useCallback } from "react";
import { Plus, Trash2, FolderOpen, AlertTriangle } from "lucide-react";
import type { SftpPathMapping } from "../../types";
import { useT } from "../../lib/i18n";

interface PathMappingsEditorProps {
  mappings: SftpPathMapping[];
  onChange: (mappings: SftpPathMapping[]) => void;
  /** Whether to show local path browse buttons (only available in Tauri runtime). */
  canBrowseLocal?: boolean;
  /** Called when user clicks browse for a local path entry. */
  onBrowseLocal?: (index: number, current: string) => Promise<string | null>;
  /** If provided, validates whether a remote path exists. */
  onValidateRemote?: (path: string) => Promise<boolean>;
  compact?: boolean;
}

export function PathMappingsEditor({
  mappings,
  onChange,
  canBrowseLocal,
  onBrowseLocal,
  compact = false,
}: PathMappingsEditorProps) {
  const t = useT();
  const [validating, setValidating] = useState<Record<number, boolean>>({});

  const handleAdd = useCallback(() => {
    onChange([...mappings, { localPath: "", remotePath: "/" }]);
  }, [mappings, onChange]);

  const handleRemove = useCallback(
    (index: number) => {
      onChange(mappings.filter((_, i) => i !== index));
    },
    [mappings, onChange],
  );

  const handleChange = useCallback(
    (index: number, field: keyof SftpPathMapping, value: string) => {
      const next = mappings.map((m, i) =>
        i === index ? { ...m, [field]: value } : m,
      );
      onChange(next);
    },
    [mappings, onChange],
  );

  const handleBrowseLocal = useCallback(
    async (index: number) => {
      if (!onBrowseLocal) return;
      const current = mappings[index]?.localPath ?? "";
      setValidating((v) => ({ ...v, [index]: true }));
      try {
        const selected = await onBrowseLocal(index, current);
        if (selected) {
          handleChange(index, "localPath", selected);
        }
      } finally {
        setValidating((v) => {
          const next = { ...v };
          delete next[index];
          return next;
        });
      }
    },
    [mappings, handleChange, onBrowseLocal],
  );

  const rowCls = compact
    ? "grid grid-cols-[1fr_1fr_auto] gap-1 items-center"
    : "grid grid-cols-[1fr_1fr_auto] gap-2 items-center";

  const inputCls = "taomni-input w-full text-[11px]";

  return (
    <div
      data-testid="sftp-path-mappings-editor"
      className={compact ? "text-[11px]" : "text-[12px]"}
    >
      {/* Header row */}
      <div className={`${rowCls} mb-1 text-[var(--taomni-text-muted)] font-medium`}>
        <span className="text-[11px]">{t("pathMappings.colLocalPath")}</span>
        <span className="text-[11px]">{t("pathMappings.colRemotePath")}</span>
        <span />
      </div>

      {mappings.length === 0 && (
        <div
          className="py-2 text-center text-[var(--taomni-text-muted)] text-[11px] rounded border border-dashed"
          style={{ borderColor: "var(--taomni-divider)" }}
        >
          {t("pathMappings.empty")}
        </div>
      )}

      {mappings.map((mapping, index) => {
        const localEmpty = !mapping.localPath.trim();
        const remoteEmpty = !mapping.remotePath.trim();
        const hasWarning = localEmpty || remoteEmpty;

        return (
          <div
            key={index}
            className={`${rowCls} mb-1 group`}
            data-testid={`path-mapping-row-${index}`}
          >
            {/* Local path */}
            <div className="flex items-center gap-1 min-w-0">
              <input
                className={`${inputCls} ${localEmpty ? "border-amber-500" : ""}`}
                value={mapping.localPath}
                placeholder={t("pathMappings.localPlaceholder")}
                aria-label={t("pathMappings.localPathAria", { index: String(index + 1) })}
                onChange={(e) => handleChange(index, "localPath", e.target.value)}
                data-testid={`path-mapping-local-${index}`}
              />
              {canBrowseLocal && onBrowseLocal && (
                <button
                  type="button"
                  className="px-1 py-0.5 hover:bg-[var(--taomni-hover)] rounded shrink-0"
                  title={t("pathMappings.browseLocalTitle")}
                  disabled={validating[index]}
                  onClick={() => void handleBrowseLocal(index)}
                  data-testid={`path-mapping-browse-local-${index}`}
                >
                  <FolderOpen className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Remote path */}
            <div className="flex items-center gap-1 min-w-0">
              {hasWarning && (
                <span title={t("pathMappings.warningIncomplete")}>
                  <AlertTriangle
                    className="w-3 h-3 shrink-0 text-amber-500"
                  />
                </span>
              )}
              <input
                className={`${inputCls} ${remoteEmpty ? "border-amber-500" : ""}`}
                value={mapping.remotePath}
                placeholder={t("pathMappings.remotePlaceholder")}
                aria-label={t("pathMappings.remotePathAria", { index: String(index + 1) })}
                onChange={(e) => handleChange(index, "remotePath", e.target.value)}
                data-testid={`path-mapping-remote-${index}`}
              />
            </div>

            {/* Remove button */}
            <button
              type="button"
              className="px-1 py-0.5 hover:bg-red-100 dark:hover:bg-red-900/20 hover:text-red-600 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity shrink-0"
              title={t("pathMappings.removeTitle")}
              onClick={() => handleRemove(index)}
              data-testid={`path-mapping-remove-${index}`}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        className="mt-1 px-2 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--taomni-hover)] text-[var(--taomni-accent)] text-[11px]"
        onClick={handleAdd}
        data-testid="path-mapping-add"
      >
        <Plus className="w-3 h-3" />
        {t("pathMappings.addMapping")}
      </button>
    </div>
  );
}

/**
 * Parse path mappings from an options_json string.
 * Returns an empty array if the field is missing or invalid.
 */
export function parsePathMappings(optionsJson: string | null | undefined): SftpPathMapping[] {
  if (!optionsJson) return [];
  try {
    const parsed = JSON.parse(optionsJson) as Record<string, unknown>;
    const raw = parsed.pathMappings;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (item): item is SftpPathMapping =>
          item != null &&
          typeof item === "object" &&
          typeof (item as SftpPathMapping).localPath === "string" &&
          typeof (item as SftpPathMapping).remotePath === "string",
      )
      .map((item) => ({
        localPath: item.localPath,
        remotePath: item.remotePath,
      }));
  } catch {
    return [];
  }
}

/**
 * Given a local file path and a set of path mappings, determine the
 * corresponding remote path. Returns null if no mapping matches.
 *
 * Matching rules (longest-prefix wins):
 *  - The local path must start with the mapping's localPath
 *  - The relative part is appended to the mapping's remotePath
 */
export function resolveRemoteByMapping(
  localFilePath: string,
  mappings: SftpPathMapping[],
): string | null {
  if (!mappings.length) return null;

  // Normalize separators to forward slashes for matching
  const normLocal = localFilePath.replace(/\\/g, "/");

  let bestMatch: SftpPathMapping | null = null;
  let bestLength = -1;

  for (const mapping of mappings) {
    if (!mapping.localPath.trim() || !mapping.remotePath.trim()) continue;
    const normMappingLocal = mapping.localPath.replace(/\\/g, "/").replace(/\/?$/, "");
    if (
      normLocal === normMappingLocal ||
      normLocal.startsWith(normMappingLocal + "/")
    ) {
      if (normMappingLocal.length > bestLength) {
        bestLength = normMappingLocal.length;
        bestMatch = mapping;
      }
    }
  }

  if (!bestMatch) return null;

  const normMappingLocal = bestMatch.localPath.replace(/\\/g, "/").replace(/\/?$/, "");
  const normRemote = bestMatch.remotePath.replace(/\/?$/, "");
  const relative = normLocal.slice(normMappingLocal.length); // "" or "/rest/of/path"
  return relative ? `${normRemote}${relative}` : normRemote;
}

/**
 * Given a remote file path and a set of path mappings, determine the
 * corresponding local path. Returns null if no mapping matches.
 */
export function resolveLocalByMapping(
  remoteFilePath: string,
  mappings: SftpPathMapping[],
): string | null {
  if (!mappings.length) return null;

  const normRemote = remoteFilePath.replace(/\\/g, "/");

  let bestMatch: SftpPathMapping | null = null;
  let bestLength = -1;

  for (const mapping of mappings) {
    if (!mapping.localPath.trim() || !mapping.remotePath.trim()) continue;
    const normMappingRemote = mapping.remotePath.replace(/\\/g, "/").replace(/\/?$/, "");
    if (
      normRemote === normMappingRemote ||
      normRemote.startsWith(normMappingRemote + "/")
    ) {
      if (normMappingRemote.length > bestLength) {
        bestLength = normMappingRemote.length;
        bestMatch = mapping;
      }
    }
  }

  if (!bestMatch) return null;

  const normMappingRemote = bestMatch.remotePath.replace(/\\/g, "/").replace(/\/?$/, "");
  const normLocal = bestMatch.localPath.replace(/\\/g, "/").replace(/\/?$/, "");
  const relative = normRemote.slice(normMappingRemote.length); // "" or "/rest/of/path"
  // Re-apply original local path separator style (Windows paths use backslash)
  const result = relative ? `${normLocal}${relative}` : normLocal;
  // If the original localPath uses backslashes (Windows), convert separators back
  if (bestMatch.localPath.includes("\\")) {
    return result.replace(/\//g, "\\");
  }
  return result;
}
