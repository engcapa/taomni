import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";

export type WorkspaceFsModalKind = "file" | "folder" | "root";

export interface WorkspaceFsModalRequest {
  kind: WorkspaceFsModalKind;
  /** Directory (relative to the root folder) the new node is created in. */
  directory: string;
  rootFolderName?: string;
  rootPath?: string;
}

export interface WorkspaceFsModalsProps {
  request: WorkspaceFsModalRequest | null;
  onCancel: () => void;
  onSubmit: (value: string) => void | Promise<void>;
}

const TITLES: Record<WorkspaceFsModalKind, string> = {
  file: "platform.newFileTitle",
  folder: "platform.newFolderTitle",
  root: "platform.addRootTitle",
};

const LABELS: Record<WorkspaceFsModalKind, string> = {
  file: "platform.fileName",
  folder: "platform.folderName",
  root: "platform.folderPath",
};

const PLACEHOLDERS: Record<WorkspaceFsModalKind, string> = {
  file: "utils.ts",
  folder: "components",
  root: "~/code/infra-deploy",
};

/**
 * New file / new folder / add multi-root folder dialog (AC-08).
 *
 * Rendered as a small centered modal so browser and native automation can fill
 * the same stable `data-testid` controls instead of a native OS dialog.
 */
export function WorkspaceFsModals({ request, onCancel, onSubmit }: WorkspaceFsModalsProps) {
  const t = useT();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setValue("");
    setBusy(false);
    if (request) {
      const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [request]);

  if (!request) return null;

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        data-testid="workspace-fs-modal"
        data-kind={request.kind}
        role="dialog"
        aria-modal="true"
        aria-label={t(TITLES[request.kind])}
        className="w-[380px] rounded-lg border p-3 shadow-2xl"
        style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-panel-bg)" }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
          if (event.key === "Enter") void submit();
        }}
      >
        <div className="mb-1 font-semibold text-[var(--taomni-text)]">{t(TITLES[request.kind])}</div>
        {request.kind === "root" ? (
          <p className="mb-2 text-[11.5px] text-[var(--taomni-text-muted)]">{t("platform.addRootHint")}</p>
        ) : (
          <p className="mb-2 text-[11.5px] text-[var(--taomni-text-muted)]">
            {request.rootFolderName ?? ""}
            {request.directory ? ` / ${request.directory}` : ""}
          </p>
        )}
        <input
          ref={inputRef}
          data-testid="workspace-fs-modal-input"
          className="taomni-input h-7 w-full"
          aria-label={t(LABELS[request.kind])}
          placeholder={PLACEHOLDERS[request.kind]}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" data-testid="workspace-fs-modal-cancel" className="taomni-btn h-7 px-2" onClick={onCancel}>
            {t("platform.cancel")}
          </button>
          <button
            type="button"
            data-testid="workspace-fs-modal-confirm"
            className="taomni-btn taomni-btn-primary h-7 px-2"
            disabled={!value.trim() || busy}
            onClick={() => void submit()}
          >
            {request.kind === "root" ? t("platform.add") : t("platform.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
