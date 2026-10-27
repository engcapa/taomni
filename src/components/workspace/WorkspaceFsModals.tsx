import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { useT } from "../../lib/i18n";
import { selectFolderPath } from "../../lib/ipc";

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
  initialPath?: string;
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
 * Adding a root accepts a typed path or the platform's native folder picker.
 */
export function WorkspaceFsModals({ request, initialPath, onCancel, onSubmit }: WorkspaceFsModalsProps) {
  const t = useT();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    setValue("");
    setBusy(false);
    setPicking(false);
    setError("");
    generation.current += 1;
    if (request) {
      const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => { window.clearTimeout(timer); generation.current += 1; };
    }
    return undefined;
  }, [request]);

  if (!request) return null;

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy || picking) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    if (busy || picking) return;
    const current = generation.current;
    setPicking(true);
    setError("");
    try {
      const selected = await selectFolderPath(value.trim() || request.rootPath || initialPath);
      if (generation.current === current && selected) setValue(selected);
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === current) {
        setPicking(false);
        inputRef.current?.focus();
      }
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
        className="w-[460px] max-w-[calc(100vw-32px)] rounded-lg border p-3 shadow-2xl"
        style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-panel-bg)" }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
          if (event.key === "Enter" && event.target === inputRef.current) {
            event.preventDefault();
            void submit();
          }
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
        <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          data-testid="workspace-fs-modal-input"
          className="taomni-input h-7 min-w-0 flex-1"
          aria-label={t(LABELS[request.kind])}
          placeholder={PLACEHOLDERS[request.kind]}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {request.kind === "root" && <button
          type="button"
          data-testid="workspace-fs-modal-browse"
          className="taomni-btn inline-flex h-7 shrink-0 items-center gap-1 px-2"
          disabled={busy || picking}
          aria-busy={picking}
          onClick={() => void browse()}
        ><FolderOpen className="h-3.5 w-3.5" />{t("platform.browseFolder")}</button>}
        </div>
        {error && <p data-testid="workspace-fs-modal-error" role="alert" className="mt-2 text-[11.5px] text-red-500">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" data-testid="workspace-fs-modal-cancel" className="taomni-btn h-7 px-2" onClick={onCancel}>
            {t("platform.cancel")}
          </button>
          <button
            type="button"
            data-testid="workspace-fs-modal-confirm"
            className="taomni-btn taomni-btn-primary h-7 px-2"
            disabled={!value.trim() || busy || picking}
            onClick={() => void submit()}
          >
            {request.kind === "root" ? t("platform.add") : t("platform.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
