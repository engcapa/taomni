import { type SetStateAction } from "react";
import { type MailDraftAttachment } from "../../../lib/mail";
import { buildInlineImageHtml } from "../../../lib/mailHtml";
import { readFileBytes, temporaryFilePath } from "../../../lib/ipc";
import { readClipboardImageFiles, readNativeClipboardImagePath } from "../../../lib/clipboard";
import { type ComposeDraft } from "./types";
import { mailClientErrorMessage } from "./messages";
import { basename, guessContentType, uint8ToBase64, makeInlineImageContentId, extensionForMime, writeBytesToPath } from "./attachments";



export interface AddDraftAttachmentPathsContext {
  setAttachProgress: import("react").Dispatch<SetStateAction<{ done: number; total: number; label: string; } | null>>;
  setDraft: import("react").Dispatch<SetStateAction<ComposeDraft>>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
}


export function createAddDraftAttachmentPaths(controllerContext: AddDraftAttachmentPathsContext): (paths: string[]) => Promise<void> {
  return async (paths: string[]) => {
    const unique = paths.map((path) => path.trim()).filter(Boolean);
    if (unique.length === 0) return;
    controllerContext.setAttachProgress({ done: 0, total: unique.length, label: "Attaching files…" });
    try {
      controllerContext.setDraft((current) => {
        const existing = new Set(current.attachments.map((attachment) => attachment.path));
        const nextAttachments = unique
          .filter((path) => !existing.has(path))
          .map((path) => {
            const name = basename(path);
            return {
              path,
              name,
              contentType: guessContentType(name),
              size: null,
              modifiedAt: null,
            } satisfies MailDraftAttachment;
          });
        return { ...current, attachments: [...current.attachments, ...nextAttachments] };
      });
      controllerContext.setAttachProgress({ done: unique.length, total: unique.length, label: "Attachments ready" });
      controllerContext.setStatus(
        unique.length === 1
          ? `Attached ${basename(unique[0])}`
          : `Attached ${unique.length} files`,
      );
      window.setTimeout(() => controllerContext.setAttachProgress(null), 1200);
    } catch (e) {
      controllerContext.setAttachProgress(null);
      controllerContext.setError(mailClientErrorMessage(e));
    }
  };
}



export interface InsertInlineImageFromPathContext {
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  setDraft: import("react").Dispatch<SetStateAction<ComposeDraft>>;
}


export function createInsertInlineImageFromPath(controllerContext: InsertInlineImageFromPathContext): (path: string) => Promise<string | null> {
  return async (path: string): Promise<string | null> => {
    const name = basename(path);
    const contentType = guessContentType(name);
    if (!contentType.toLowerCase().startsWith("image/")) {
      controllerContext.setError("Inline image must be a local image file.");
      return null;
    }
    const bytes = await readFileBytes(path);
    const dataUrl = `data:${contentType};base64,${uint8ToBase64(bytes)}`;
    const contentId = makeInlineImageContentId(name);
    const attachment: MailDraftAttachment = {
      path,
      name,
      contentType,
      inline: true,
      contentId,
      size: bytes.byteLength,
      modifiedAt: null,
    };
    controllerContext.setDraft((current) => ({
      ...current,
      richFormatUsed: true,
      attachments: [...current.attachments, attachment],
    }));
    return buildInlineImageHtml({ contentId, dataUrl, alt: name });
  };
}



export interface InsertInlineImageFromFileContext {
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  setDraft: import("react").Dispatch<SetStateAction<ComposeDraft>>;
}


export function createInsertInlineImageFromFile(controllerContext: InsertInlineImageFromFileContext): (file: File) => Promise<string | null> {
  return async (file: File): Promise<string | null> => {
    const mime = file.type || "image/png";
    if (!mime.toLowerCase().startsWith("image/")) {
      controllerContext.setError("Inline image must be an image file.");
      return null;
    }
    const ext = extensionForMime(mime);
    const name = (file.name?.trim() || `pasted-image.${ext}`).replace(/[\\/]/g, "_");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const path = await temporaryFilePath(name);
    await writeBytesToPath(path, bytes);
    const dataUrl = `data:${mime};base64,${uint8ToBase64(bytes)}`;
    const contentId = makeInlineImageContentId(name);
    const attachment: MailDraftAttachment = {
      path,
      name,
      contentType: mime,
      inline: true,
      contentId,
      size: bytes.byteLength,
      modifiedAt: null,
    };
    controllerContext.setDraft((current) => ({
      ...current,
      richFormatUsed: true,
      attachments: [...current.attachments, attachment],
    }));
    return buildInlineImageHtml({ contentId, dataUrl, alt: name });
  };
}



export interface HandlePasteImagesContext {
  setAttachProgress: import("react").Dispatch<SetStateAction<{ done: number; total: number; label: string; } | null>>;
  insertInlineImageFromPath: (path: string) => Promise<string | null>;
  setStatus: import("react").Dispatch<SetStateAction<string | null>>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
  insertInlineImageFromFile: (file: File) => Promise<string | null>;
}


export function createHandlePasteImages(controllerContext: HandlePasteImagesContext): (files: File[]) => Promise<string[]> {
  return async (files: File[]): Promise<string[]> => {
    const snippets: string[] = [];
    // Prefer files from the paste event when present (multi-image). When the
    // webview omits image/* (common on Linux WebKitGTK for screenshots), fall
    // back to native arboard, then the async Clipboard API.
    let imageFiles = files.filter((file) => (file.type || "").startsWith("image/"));
    if (imageFiles.length === 0) {
      const nativePath = await readNativeClipboardImagePath();
      if (nativePath) {
        controllerContext.setAttachProgress({ done: 0, total: 1, label: "Inserting images…" });
        try {
          const html = await controllerContext.insertInlineImageFromPath(nativePath);
          if (html) {
            controllerContext.setAttachProgress({ done: 1, total: 1, label: "Images inserted" });
            controllerContext.setStatus("Image pasted");
            window.setTimeout(() => controllerContext.setAttachProgress(null), 1200);
            return [html];
          }
        } catch (e) {
          controllerContext.setAttachProgress(null);
          controllerContext.setError(mailClientErrorMessage(e));
          return [];
        }
      }
      imageFiles = await readClipboardImageFiles();
    }
    if (imageFiles.length === 0) return [];

    controllerContext.setAttachProgress({ done: 0, total: imageFiles.length, label: "Inserting images…" });
    try {
      for (let i = 0; i < imageFiles.length; i += 1) {
        const html = await controllerContext.insertInlineImageFromFile(imageFiles[i]);
        if (html) snippets.push(html);
        controllerContext.setAttachProgress({ done: i + 1, total: imageFiles.length, label: "Inserting images…" });
      }
      controllerContext.setAttachProgress({ done: imageFiles.length, total: imageFiles.length, label: "Images inserted" });
      if (snippets.length > 0) {
        controllerContext.setStatus(snippets.length === 1 ? "Image pasted" : `${snippets.length} images pasted`);
      }
      window.setTimeout(() => controllerContext.setAttachProgress(null), 1200);
      return snippets;
    } catch (e) {
      controllerContext.setAttachProgress(null);
      controllerContext.setError(mailClientErrorMessage(e));
      return snippets;
    }
  };
}



export interface HandleDropComposeFilesContext {
  setAttachProgress: import("react").Dispatch<SetStateAction<{ done: number; total: number; label: string; } | null>>;
  addDraftAttachmentPaths: (paths: string[]) => Promise<void>;
  setError: import("react").Dispatch<SetStateAction<string | null>>;
}


export function createHandleDropComposeFiles(controllerContext: HandleDropComposeFilesContext): (files: File[]) => Promise<void> {
  return async (files: File[]) => {
    if (files.length === 0) return;
    controllerContext.setAttachProgress({ done: 0, total: files.length, label: "Attaching files…" });
    try {
      const paths: string[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const name = (file.name?.trim() || `attachment-${i + 1}`).replace(/[\\/]/g, "_");
        const path = await temporaryFilePath(name);
        const bytes = new Uint8Array(await file.arrayBuffer());
        await writeBytesToPath(path, bytes);
        paths.push(path);
        controllerContext.setAttachProgress({ done: i + 1, total: files.length, label: "Attaching files…" });
      }
      await controllerContext.addDraftAttachmentPaths(paths);
    } catch (e) {
      controllerContext.setAttachProgress(null);
      controllerContext.setError(mailClientErrorMessage(e));
    }
  };
}
