import { FolderOpen, Search, AlertTriangle, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { type LocalDirectoryShortcut } from "../../lib/ipc";
import { type TranslateFn } from "../../lib/i18n";


export function LocalDirectoriesPanel({
  translate: t,
  directories,
  pendingDirectoryIds,
  loadStatus,
  loadError,
  onRetry,
  onStartInDirectory,
}: {
  translate: TranslateFn;
  directories: LocalDirectoryShortcut[];
  pendingDirectoryIds: string[];
  loadStatus: "loading" | "ready" | "error";
  loadError: string | null;
  onRetry: () => void;
  onStartInDirectory: (directory: LocalDirectoryShortcut) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const filteredDirectories = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return directories;
    return directories.filter((directory) =>
      [directory.label, directory.path, directory.kind]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [directories, query]);
  const hasFilter = query.trim().length > 0;

  return (
    <section data-testid="welcome-local-directories" className="min-w-0">
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-[min(100%,240px)] flex-[1_1_240px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
          <input
            data-testid="welcome-local-directory-filter"
            className="taomni-input h-8 w-full"
            style={{ paddingLeft: "2rem" }}
            type="search"
            aria-label={t("welcome.localDirectoriesSearch")}
            placeholder={t("welcome.localDirectoriesSearch")}
            value={query}
            disabled={directories.length === 0}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      {loadStatus === "error" && directories.length === 0 ? (<div
        data-testid="welcome-local-directories-error"
        className="mb-2 flex flex-wrap items-center gap-2 rounded border px-2 py-2 text-[12px]"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-input-bg)" }}
        role="alert"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-warning, #d97706)]" />
        <span className="min-w-0 flex-1 text-[var(--taomni-text-muted)]">
          {t("welcome.localDirectoriesLoadFailed", { error: loadError ?? "" })}
        </span>
        <button
          data-testid="welcome-directory-retry"
          className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
          type="button"
          onClick={() => onRetry()}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <span>{t("welcome.localDirectoriesRetry")}</span>
        </button>
      </div>
      ) : null}
      {loadError != null && directories.length > 0 ? (
        <div
          className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]"
          role="status"
        >
          <span>{t("welcome.localDirectoriesRefreshFailed")}</span>
          <button
            data-testid="welcome-directory-retry"
            className="taomni-btn h-6 px-2 inline-flex items-center gap-1"
            type="button"
            onClick={() => onRetry()}
          >
            <RotateCcw className="h-3 w-3" />
            <span>{t("welcome.localDirectoriesRetry")}</span>
          </button>
        </div>
      ) : null}
      <div className="max-h-[320px] overflow-auto pr-1">
        {directories.length === 0 ? (
          <div className="py-4 text-[12px] text-[var(--taomni-text-muted)]">
            {loadStatus === "loading"
              ? t("welcome.localDirectoriesLoading")
              : t("welcome.localDirectoriesEmpty")}
          </div>
        ) : filteredDirectories.length === 0 ? (
          <div className="py-4 text-[12px] text-[var(--taomni-text-muted)]" data-testid="welcome-local-directories-no-matches">
            {t("welcome.localDirectoriesNoMatches")}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredDirectories.map((directory) => {
              const directoryId = directory.directoryId || `${directory.kind}:${directory.path}`;
              const pending = pendingDirectoryIds.includes(directoryId);
              const unavailable =
                directory.availability === "missing" ||
                directory.availability === "permission-denied" ||
                directory.availability === "unavailable";
              return (
                <button
                  key={`${directory.kind}:${directory.path}`}
                  data-testid="welcome-local-directory"
                  data-directory-path={directory.path}
                  data-directory-id={directory.directoryId}
                  data-last-used-at-ms={directory.lastUsedAtMs ?? ""}
                  data-availability={directory.availability}
                  className="w-full min-w-0 rounded border bg-[var(--taomni-input-bg)] px-2 py-1.5 text-left hover:bg-[var(--taomni-control-hover)] focus-visible:bg-[var(--taomni-control-hover)] disabled:opacity-60"
                  style={{ borderColor: "var(--taomni-divider)" }}
                  type="button"
                  disabled={pending}
                  aria-busy={pending || undefined}
                  title={directoryTimeTooltip(directory, t)}
                  aria-label={t("welcome.localDirectoryOpenAria", { label: directory.label, path: directory.path })}
                  onClick={() => void onStartInDirectory(directory)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <FolderOpen className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--taomni-text)]">
                      {directory.label}
                    </span>
                    {unavailable ? (
                      <span
                        data-testid="welcome-local-directory-unavailable"
                        className="shrink-0 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-[var(--taomni-warning, #d97706)]"
                        style={{ borderColor: "var(--taomni-divider)" }}
                      >
                        <AlertTriangle className="w-3 h-3" />
                        {t("welcome.localDirectoryUnavailableShort")}
                      </span>
                    ) : null}
                    <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] taomni-mono text-[var(--taomni-text-muted)]" style={{ borderColor: "var(--taomni-divider)" }}>
                      {directory.kind === "personal" ? t("welcome.localDirectoryPersonal") : t("welcome.localDirectorySystem")}
                    </span>
                    <span
                      className="shrink-0 text-[10px] taomni-mono text-[var(--taomni-text-muted)]"
                      data-testid="welcome-local-directory-last-used"
                    >
                      {directory.lastUsedAtMs != null
                        ? formatDirectoryUsedTime(directory.lastUsedAtMs)
                        : directory.legacyRank != null
                          ? t("welcome.localDirectoryTimeUnknown")
                          : ""}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] taomni-mono text-[var(--taomni-text-muted)]">
                    {directory.path}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {hasFilter && filteredDirectories.length > 0 ? (
        <div className="mt-2 text-[11px] text-[var(--taomni-text-muted)]" data-testid="welcome-local-directories-filter-count">
          {t("welcome.localDirectoriesFilterCount", {
            visible: filteredDirectories.length,
            total: directories.length,
          })}
        </div>
      ) : null}
    </section>
  );
}


export function formatDirectoryUsedTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}


/** Compact hover text: real UTC time for used rows; never the current time. */
export function directoryTimeTooltip(
  directory: LocalDirectoryShortcut,
  t: TranslateFn,
): string {
  if (directory.lastUsedAtMs != null) {
    const local = formatDirectoryUsedTime(directory.lastUsedAtMs);
    const utc = new Date(directory.lastUsedAtMs).toISOString();
    return `${t("welcome.localDirectoryUsedAt", { time: local })} · ${utc}`;
  }
  if (directory.legacyRank != null) {
    return t("welcome.localDirectoryTimeUnknown");
  }
  return t("welcome.localDirectoryNeverUsed");
}
