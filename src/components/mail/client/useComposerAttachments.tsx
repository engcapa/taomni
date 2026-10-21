import { useCallback, useEffect, type SetStateAction } from "react";
import { mailHtmlToPlainText } from "../../../lib/mailHtml";
import { selectUploadFile } from "../../../lib/ipc";
import { NATIVE_FILE_DROP_EVENT, type NativeFileDropDetail } from "../../../lib/osFileDrop";
import { type ComposeDraft } from "./types";
import { mailClientErrorMessage } from "./messages";
import { escapeRegExp } from "./attachments";
import {
  createAddDraftAttachmentPaths,
  createInsertInlineImageFromPath,
  createInsertInlineImageFromFile,
  createHandlePasteImages,
  createHandleDropComposeFiles,
} from "./composerAttachments";


export interface UseComposerAttachmentsContext {
  setAttachProgress: import("react").Dispatch<SetStateAction<{ done: number; total: number; label: string; } | null>>;
  setDraft: import("react").Dispatch<SetStateAction<ComposeDraft>>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  composeOpen: boolean;
  setComposeDragActive: import("react").Dispatch<SetStateAction<boolean>>;
  sending: boolean;
  composeRootRef: import("react").RefObject<HTMLDivElement | null>;
}

export function useComposerAttachments(context: UseComposerAttachmentsContext) {
  const { setAttachProgress, setDraft, setStatus, setError, composeOpen, setComposeDragActive, sending, composeRootRef } = context;

  const addDraftAttachmentPaths = useCallback(createAddDraftAttachmentPaths({
    setAttachProgress,
    setDraft,
    setStatus,
    setError,
  }), []);

  const handleAddDraftAttachments = async () => {
    try {
      const paths = await selectUploadFile();
      if (!paths.length) return;
      await addDraftAttachmentPaths(paths);
    } catch (e) {
      setError(mailClientErrorMessage(e));
    }
  };

  const insertInlineImageFromPath = useCallback(createInsertInlineImageFromPath({
    setError,
    setDraft,
  }), []);

  const insertInlineImageFromFile = useCallback(createInsertInlineImageFromFile({
    setError,
    setDraft,
  }), []);

  const handleInsertInlineImage = async (): Promise<string | null> => {
    try {
      const paths = await selectUploadFile();
      const path = paths[0];
      if (!path) return null;
      return await insertInlineImageFromPath(path);
    } catch (e) {
      setError(mailClientErrorMessage(e));
      return null;
    }
  };

  const handlePasteImages = useCallback(createHandlePasteImages({
    setAttachProgress,
    insertInlineImageFromPath,
    setStatus,
    setError,
    insertInlineImageFromFile,
  }), [insertInlineImageFromFile, insertInlineImageFromPath]);

  const handleDropComposeFiles = useCallback(createHandleDropComposeFiles({
    setAttachProgress,
    addDraftAttachmentPaths,
    setError,
  }), [addDraftAttachmentPaths]);

  const removeDraftAttachment = (index: number) => {
    setDraft((current) => {
      const removed = current.attachments[index];
      const attachments = current.attachments.filter((_, i) => i !== index);
      if (!removed?.inline || !removed.contentId) {
        return { ...current, attachments };
      }
      const cid = escapeRegExp(removed.contentId);
      const htmlBody = current.htmlBody
        .replace(new RegExp(`<img\\b[^>]*\\bdata-taomni-cid=["']${cid}["'][^>]*>`, "gi"), "")
        .replace(new RegExp(`<img\\b[^>]*\\bsrc=["']cid:${cid}["'][^>]*>`, "gi"), "");
      return {
        ...current,
        attachments,
        htmlBody,
        textBody: mailHtmlToPlainText(htmlBody),
      };
    });
  };

  useEffect(() => {
    if (!composeOpen) {
      setComposeDragActive(false);
      return;
    }
    const handleNativeFileDrop = (event: Event) => {
      if (sending) return;
      const detail = (event as CustomEvent<NativeFileDropDetail>).detail;
      if (!detail?.paths?.length) return;
      const root = composeRootRef.current;
      const target = document.elementFromPoint(detail.clientX, detail.clientY);
      if (!root || !target || !root.contains(target)) return;
      setComposeDragActive(false);
      void addDraftAttachmentPaths(detail.paths);
    };
    window.addEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
    return () => window.removeEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
  }, [addDraftAttachmentPaths, composeOpen, sending]);
  return { handleAddDraftAttachments, addDraftAttachmentPaths, handleDropComposeFiles, handleInsertInlineImage, handlePasteImages, removeDraftAttachment };
}
