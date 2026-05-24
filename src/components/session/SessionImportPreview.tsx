import type { SessionImportResult } from "../../lib/sessionImportExport";
import { folderOptionLabel } from "../../lib/sessionPaths";

export interface SessionImportPreviewProps {
  source: string;
  result: SessionImportResult;
  targetFolder: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function SessionImportPreview({
  source,
  result,
  targetFolder,
  onCancel,
  onConfirm,
}: SessionImportPreviewProps) {
  const previewRows = result.sessions.slice(0, 80);
  const remaining = result.sessions.length - previewRows.length;
  const target = folderOptionLabel(targetFolder);
  const sessionPasswordCount = result.secrets.filter(
    (secret) => secret.kind === "password" && secret.attachment !== "standalone",
  ).length;
  const standaloneSecretCount = result.secrets.filter(
    (secret) => secret.attachment === "standalone",
  ).length;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-label="Preview session import"
        aria-modal="true"
        data-testid="session-import-preview"
        className="w-[760px] max-w-[94vw] max-h-[86vh] flex flex-col rounded shadow-lg"
        style={{ background: "var(--moba-bg)", border: "1px solid var(--moba-card-border)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="px-4 py-3 border-b"
          style={{ borderColor: "var(--moba-divider)" }}
        >
          <div className="text-sm font-semibold">Import {source} sessions</div>
          <div className="text-[12px] text-[var(--moba-text-muted)] mt-1">
            {result.sessions.length} session{result.sessions.length === 1 ? "" : "s"} will be imported into {target}
            {result.skipped ? `, ${result.skipped} skipped` : ""}.
          </div>
          {sessionPasswordCount > 0 && (
            <div className="text-[12px] text-[var(--moba-text-muted)] mt-1">
              {sessionPasswordCount} saved password{sessionPasswordCount === 1 ? "" : "s"} will be stored in the NewMob credential vault.
            </div>
          )}
          {standaloneSecretCount > 0 && (
            <div className="text-[12px] text-[var(--moba-text-muted)] mt-1">
              + {standaloneSecretCount} standalone secret{standaloneSecretCount === 1 ? "" : "s"} (e.g. private-key passphrases) will be saved as separate vault entries.
            </div>
          )}
        </div>

        {result.warnings.length > 0 && (
          <div
            data-testid="session-import-preview-warnings"
            className="mx-4 mt-3 rounded border p-2 text-[12px]"
            style={{ borderColor: "#c78b2d", background: "rgba(199,139,45,0.12)" }}
          >
            <div className="font-semibold mb-1">Warnings</div>
            <ul className="list-disc pl-5 space-y-0.5">
              {result.warnings.slice(0, 6).map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
            </ul>
            {result.warnings.length > 6 && (
              <div className="mt-1 text-[var(--moba-text-muted)]">
                {result.warnings.length - 6} more warning{result.warnings.length - 6 === 1 ? "" : "s"}.
              </div>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {previewRows.length > 0 ? (
            <table
              data-testid="session-import-preview-table"
              className="w-full border-collapse text-[12px]"
            >
              <thead>
                <tr style={{ background: "var(--moba-hover)" }}>
                  <th className="text-left px-2 py-1 border" style={{ borderColor: "var(--moba-divider)" }}>Name</th>
                  <th className="text-left px-2 py-1 border" style={{ borderColor: "var(--moba-divider)" }}>Type</th>
                  <th className="text-left px-2 py-1 border" style={{ borderColor: "var(--moba-divider)" }}>Host</th>
                  <th className="text-left px-2 py-1 border" style={{ borderColor: "var(--moba-divider)" }}>Port</th>
                  <th className="text-left px-2 py-1 border" style={{ borderColor: "var(--moba-divider)" }}>Folder</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((session) => (
                  <tr key={session.id}>
                    <td className="px-2 py-1 border max-w-[180px] truncate" style={{ borderColor: "var(--moba-divider)" }} title={session.name}>
                      {session.name}
                    </td>
                    <td className="px-2 py-1 border" style={{ borderColor: "var(--moba-divider)" }}>{session.session_type}</td>
                    <td className="px-2 py-1 border max-w-[220px] truncate" style={{ borderColor: "var(--moba-divider)" }} title={session.host}>
                      {session.host || "-"}
                    </td>
                    <td className="px-2 py-1 border" style={{ borderColor: "var(--moba-divider)" }}>{session.port}</td>
                    <td className="px-2 py-1 border max-w-[220px] truncate" style={{ borderColor: "var(--moba-divider)" }} title={folderOptionLabel(session.group_path)}>
                      {folderOptionLabel(session.group_path)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-[12px] text-[var(--moba-text-muted)]">
              No importable sessions were found.
            </div>
          )}
          {remaining > 0 && (
            <div className="mt-2 text-[12px] text-[var(--moba-text-muted)]">
              {remaining} more session{remaining === 1 ? "" : "s"} not shown in preview.
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 px-4 py-3 border-t"
          style={{ borderColor: "var(--moba-divider)" }}
        >
          <button
            type="button"
            data-testid="session-import-preview-cancel"
            className="moba-btn h-8 px-3"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="session-import-preview-confirm"
            className="moba-btn h-8 px-3"
            data-primary="true"
            disabled={result.sessions.length === 0}
            onClick={onConfirm}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
