import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useFocusReturn } from "../editor/workspace/useFocusReturn";
import { selectFolderPath } from "../../lib/ipc";

export type WorkspaceFsModalKind = "file" | "folder" | "root";

export interface WorkspaceFsModalRequest {
  kind: WorkspaceFsModalKind;
  /** Directory (relative to the root folder) the new node is created in. */
  directory: string;
  rootFolderName?: string;
  rootPath?: string;
}

export interface WorkspaceRootDestination { newWorkspaceName: string }

export interface WorkspaceFsModalsProps {
  request: WorkspaceFsModalRequest | null;
  initialPath?: string;
  onCancel: () => void;
  onSubmit: (value: string, destination?: WorkspaceRootDestination) => void | Promise<void>;
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
  const [destination, setDestination] = useState("current");
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusReturn(!!request);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    setValue("");
    setDestination("current");
    setWorkspaceName(null);
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

  const suggestedName = value.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Workspace";
  const name = workspaceName ?? suggestedName;
  const createNew = request.kind === "root" && destination === "new";
  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy || picking || (createNew && !name.trim())) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      if (createNew) await onSubmit(trimmed, { newWorkspaceName: name.trim() });
      else await onSubmit(trimmed);
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === current) setBusy(false);
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
        ref={dialogRef}
        data-testid="workspace-fs-modal"
        data-kind={request.kind}
        role="dialog"
        aria-modal="true"
        aria-label={t(TITLES[request.kind])}
        className="w-[460px] max-w-[calc(100vw-32px)] rounded-lg border p-3 shadow-2xl"
        style={{ borderColor: "var(--taomni-card-border)", background: "var(--taomni-panel-bg)" }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
          if (event.key === "Tab") {
            const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled)") ?? []);
            if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
            else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
          }
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <div className="mb-1 font-semibold text-[var(--taomni-text)]">{t(TITLES[request.kind])}</div>
        {request.kind === "root" ? (
          <p className="mb-2 text-ui-small text-[var(--taomni-text-muted)]">{t("platform.addRootHint")}</p>
        ) : (
          <p className="mb-2 text-ui-small text-[var(--taomni-text-muted)]">
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
          disabled={busy || picking}
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
        {request.kind === "root" && <fieldset disabled={busy || picking} className="mt-3 space-y-2 text-ui-body">
          <legend className="mb-1 text-[var(--taomni-text-muted)]">{t("platform.folderDestination")}</legend>
          <label className="flex items-center gap-2"><input type="radio" name="workspace-root-destination" data-testid="workspace-root-current" checked={!createNew} onChange={() => setDestination("current")} />{t("platform.addToCurrentWorkspace")}</label>
          <label className="flex items-center gap-2"><input type="radio" name="workspace-root-destination" data-testid="workspace-root-new" checked={createNew} onChange={() => setDestination("new")} />{t("platform.createWorkspaceFromFolder")}</label>
          {createNew && <label className="flex items-center gap-2">{t("platform.workspaceName")}<input data-testid="workspace-root-name" className="taomni-input h-7 min-w-0 flex-1" aria-label={t("platform.workspaceName")} value={name} onChange={(event) => setWorkspaceName(event.target.value)} /></label>}
        </fieldset>}
        {error && <p data-testid="workspace-fs-modal-error" role="alert" className="mt-2 text-ui-small text-red-500">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" data-testid="workspace-fs-modal-cancel" className="taomni-btn h-7 px-2" onClick={onCancel}>
            {t("platform.cancel")}
          </button>
          <button
            type="button"
            data-testid="workspace-fs-modal-confirm"
            className="taomni-btn taomni-btn-primary h-7 px-2"
            disabled={!value.trim() || busy || picking || (createNew && !name.trim())}
            onClick={() => void submit()}
          >
            {request.kind === "root" && !createNew ? t("platform.add") : t("platform.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
