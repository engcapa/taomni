import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionImportResult } from "../../lib/sessionImportExport";
import { folderOptionLabel } from "../../lib/sessionPaths";
import { sessionTypeLabel } from "../../lib/terminalProfile";
import { useT } from "../../lib/i18n";
import { Modal } from "../ui/Modal";

export interface SessionImportPreviewProps {
  source: string;
  result: SessionImportResult;
  targetFolder: string | null;
  onCancel: () => void;
  onConfirm: (selectedIds: ReadonlySet<string>) => void;
}

export function SessionImportPreview({
  source,
  result,
  targetFolder,
  onCancel,
  onConfirm,
}: SessionImportPreviewProps) {
  const t = useT();
  const total = result.sessions.length;
  const hasRows = total > 0;
  const previewRows = result.sessions.slice(0, 80);
  const remaining = total - previewRows.length;
  const target = folderOptionLabel(targetFolder);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(result.sessions.map((session) => session.id)),
  );

  // Reset selection when a fresh result comes in (e.g. user re-opens the
  // dialog with a different file). Identity comparison on `result` is the
  // signal — SessionTree always allocates a new object per import.
  useEffect(() => {
    setSelected(new Set(result.sessions.map((session) => session.id)));
  }, [result]);

  const selectedCount = selected.size;
  const allSelected = total > 0 && selectedCount === total;
  const noneSelected = selectedCount === 0;

  const masterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (masterRef.current) {
      masterRef.current.indeterminate = !allSelected && !noneSelected;
    }
  }, [allSelected, noneSelected]);

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(result.sessions.map((session) => session.id)));
    }
  };

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const { sessionPasswordCount, standaloneSecretCount } = useMemo(() => {
    let passwords = 0;
    let standalone = 0;
    for (const secret of result.secrets) {
      const isStandalone = secret.attachment === "standalone" || !secret.sessionId;
      if (isStandalone) {
        standalone += 1;
        continue;
      }
      if (secret.kind !== "password") continue;
      if (selected.has(secret.sessionId)) passwords += 1;
    }
    return { sessionPasswordCount: passwords, standaloneSecretCount: standalone };
  }, [result.secrets, selected]);

  const handleConfirm = () => {
    if (noneSelected) return;
    onConfirm(selected);
  };

  return (
    <Modal
      size="wide"
      title={t("importPreviewExt.titleSource", { source })}
      testId="session-import-preview"
      initialFocus={hasRows ? '[data-testid="session-import-preview-confirm"]' : '[data-testid="session-import-preview-cancel"]'}
      dismissOnBackdrop={false}
      onCancel={onCancel}
      footer={
        <>
          <button
            type="button"
            data-testid="session-import-preview-cancel"
            className="taomni-btn"
            onClick={onCancel}
          >
            {t("importPreview.cancel")}
          </button>
          <button
            type="button"
            data-testid="session-import-preview-confirm"
            className="taomni-btn"
            data-primary="true"
            disabled={noneSelected}
            onClick={handleConfirm}
          >
            {t("importPreview.confirmImport")}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <div
            className="text-ui-body text-[var(--taomni-text-muted)]"
            data-testid="session-import-preview-summary"
          >
            {selectedCount} of {total} session{total === 1 ? "" : "s"} will be imported into {target}
            {result.skipped ? `, ${result.skipped} skipped` : ""}.
          </div>
          {sessionPasswordCount > 0 && (
            <div className="text-ui-body text-[var(--taomni-text-muted)] mt-1">
              {sessionPasswordCount} saved password{sessionPasswordCount === 1 ? "" : "s"} will be stored in the Taomni credential vault.
            </div>
          )}
          {standaloneSecretCount > 0 && (
            <div className="text-ui-body text-[var(--taomni-text-muted)] mt-1">
              + {standaloneSecretCount} standalone secret{standaloneSecretCount === 1 ? "" : "s"} (e.g. private-key passphrases) will be saved as separate vault entries.
            </div>
          )}
        </div>

        {result.warnings.length > 0 && (
          <div
            data-testid="session-import-preview-warnings"
            className="rounded border p-2 text-ui-body border-[var(--taomni-warning-border)] bg-[var(--taomni-warning-bg)] text-[var(--taomni-warning-text)]"
          >
            <div className="font-semibold mb-1">{t("importPreviewExt.warningsHeading")}</div>
            <ul className="list-disc pl-5 space-y-0.5">
              {result.warnings.slice(0, 6).map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
            </ul>
            {result.warnings.length > 6 && (
              <div className="mt-1 opacity-90">
                {t("importPreviewExt.warningsMore", { count: result.warnings.length - 6, plural: result.warnings.length - 6 === 1 ? "" : "s" })}
              </div>
            )}
          </div>
        )}

        <div>
          {previewRows.length > 0 ? (
            <table
              data-testid="session-import-preview-table"
              className="w-full border-collapse text-ui-body"
            >
              <thead>
                <tr style={{ background: "var(--taomni-hover)" }}>
                  <th className="px-2 py-1 border w-8" style={{ borderColor: "var(--taomni-divider)" }}>
                    <input
                      ref={masterRef}
                      type="checkbox"
                      className="taomni-checkbox"
                      data-testid="session-import-preview-select-all"
                      aria-label={allSelected ? t("importPreviewExt.deselectAll") : t("importPreviewExt.selectAll")}
                      checked={allSelected}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="text-left px-2 py-1 border" style={{ borderColor: "var(--taomni-divider)" }}>{t("importPreviewExt.columnName")}</th>
                  <th className="text-left px-2 py-1 border" style={{ borderColor: "var(--taomni-divider)" }}>{t("importPreviewExt.columnType")}</th>
                  <th className="text-left px-2 py-1 border" style={{ borderColor: "var(--taomni-divider)" }}>{t("importPreviewExt.columnHost")}</th>
                  <th className="text-left px-2 py-1 border" style={{ borderColor: "var(--taomni-divider)" }}>{t("importPreviewExt.columnPort")}</th>
                  <th className="text-left px-2 py-1 border" style={{ borderColor: "var(--taomni-divider)" }}>{t("importPreviewExt.columnFolder")}</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((session) => {
                  const checked = selected.has(session.id);
                  return (
                    <tr key={session.id}>
                      <td className="px-2 py-1 border text-center" style={{ borderColor: "var(--taomni-divider)" }}>
                        <input
                          type="checkbox"
                          className="taomni-checkbox"
                          data-testid={`session-import-preview-row-select-${session.id}`}
                          data-checked={checked}
                          aria-label={t("importPreviewExt.toggleRow", { name: session.name })}
                          checked={checked}
                          onChange={() => toggleRow(session.id)}
                        />
                      </td>
                      <td className="px-2 py-1 border max-w-[180px] truncate" style={{ borderColor: "var(--taomni-divider)" }} title={session.name}>
                        {session.name}
                      </td>
                      <td className="px-2 py-1 border" style={{ borderColor: "var(--taomni-divider)" }}>{sessionTypeLabel(session.session_type, session.options_json)}</td>
                      <td className="px-2 py-1 border max-w-[220px] truncate" style={{ borderColor: "var(--taomni-divider)" }} title={session.host}>
                        {session.host || "-"}
                      </td>
                      <td className="px-2 py-1 border" style={{ borderColor: "var(--taomni-divider)" }}>{session.port}</td>
                      <td className="px-2 py-1 border max-w-[220px] truncate" style={{ borderColor: "var(--taomni-divider)" }} title={folderOptionLabel(session.group_path)}>
                        {folderOptionLabel(session.group_path)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="text-ui-body text-[var(--taomni-text-muted)]">
              {t("importPreviewExt.noImportable")}
            </div>
          )}
          {remaining > 0 && (
            <div className="mt-2 text-ui-body text-[var(--taomni-text-muted)]">
              {t("importPreviewExt.moreNotShown", { count: remaining, plural: remaining === 1 ? "" : "s" })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
