import { useState } from "react";
import type { SessionConfig } from "../../../lib/ipc";
import { folderOptionLabel, groupPathContains, leafGroupName, normalizeGroupPath, parentGroupPath } from "../../../lib/sessionPaths";
import { sessionsInFolder } from "./model";


export interface UseSessionFoldersContext {
  createFolderPath: (path: string) => Promise<void>;
  expandPath: (path: string | null | undefined) => void;
  setStatusMessage: (message: string) => void;
  t: import("../../../lib/i18n").TranslateFn;
  renameFolderPath: (oldPath: string, newPath: string) => Promise<void>;
  sessions: SessionConfig[];
  setConfirmPrompt: import("react").Dispatch<import("react").SetStateAction<{ title?: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; } | null>>;
  deleteFolderPath: (path: string) => Promise<void>;
}

export function useSessionFolders(context: UseSessionFoldersContext) {
  const { createFolderPath, expandPath, setStatusMessage, t, renameFolderPath, sessions, setConfirmPrompt, deleteFolderPath } = context;

  const [folderDialog, setFolderDialog] = useState<
    | { mode: "create"; parentPath: string | null; }
    | { mode: "rename"; parentPath: string | null; folderPath: string; initialName: string; }
    | null
  >(null);


  const createFolder = (parentPath: string | null) => {
    setFolderDialog({ mode: "create", parentPath: normalizeGroupPath(parentPath) });
  };

  const handleCreateFolderSubmit = async (folderPath: string) => {
    const normalized = normalizeGroupPath(folderPath);
    if (!normalized) return;

    await createFolderPath(normalized);
    expandPath(normalized);
    setStatusMessage(t("sessionTree.folderCreated", { label: folderOptionLabel(normalized) }));
  };

  const renameFolder = (folderPath: string) => {
    const normalized = normalizeGroupPath(folderPath);
    if (!normalized) return;
    setFolderDialog({
      mode: "rename",
      parentPath: parentGroupPath(normalized),
      folderPath: normalized,
      initialName: leafGroupName(normalized),
    });
  };

  const handleRenameFolderSubmit = async (sourcePath: string, targetPath: string) => {
    const oldNormalized = normalizeGroupPath(sourcePath);
    const newNormalized = normalizeGroupPath(targetPath);
    if (!oldNormalized || !newNormalized || oldNormalized === newNormalized) return;
    if (groupPathContains(oldNormalized, newNormalized)) {
      window.alert(t("sessionTree.folderCannotMoveInside"));
      return;
    }

    await renameFolderPath(oldNormalized, newNormalized);
    expandPath(newNormalized);
    setStatusMessage(t("sessionTree.folderRenamed", { label: folderOptionLabel(newNormalized) }));
  };

  const handleFolderDialogSubmit = async (folderPath: string) => {
    const dialog = folderDialog;
    setFolderDialog(null);
    if (!dialog) return;
    if (dialog.mode === "create") {
      await handleCreateFolderSubmit(folderPath);
    } else {
      await handleRenameFolderSubmit(dialog.folderPath, folderPath);
    }
  };

  const deleteFolder = (folderPath: string) => {
    const affected = sessionsInFolder(sessions, folderPath);
    const suffix = affected.length > 0
      ? t("sessionTree.deleteFolderSuffix", { count: affected.length, plural: affected.length === 1 ? "" : "s" })
      : "";
    setConfirmPrompt({
      title: t("sessionTree.deleteFolderTitle"),
      message: t("sessionTree.deleteFolderMessage", { label: folderOptionLabel(folderPath), suffix }),
      confirmLabel: t("sessionTree.deleteAction"),
      danger: true,
      onConfirm: () => {
        setConfirmPrompt(null);
        void (async () => {
          await deleteFolderPath(folderPath);
          setStatusMessage(t("sessionTree.folderDeleted", { label: folderOptionLabel(folderPath) }));
        })();
      },
    });
  };
  return { createFolder, renameFolder, deleteFolder, handleFolderDialogSubmit, folderDialog, setFolderDialog };
}
