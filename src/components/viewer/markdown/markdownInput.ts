import { EditorSelection, Transaction, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { saveMarkdownImage } from "../../../lib/markdownAssets";
import { readNativeClipboardImagePath } from "../../../lib/clipboard";
import { viewerReadBytes } from "../../../lib/viewer";
import { isTauriRuntime } from "../../../lib/runtime";
import { convertTablePaste } from "./markdownModel";

interface InputOptions {
  docPath: string;
  preferences: () => { markdownImageDir: string; markdownImageTemplate: string; convertTables: boolean };
  onStatus: (message: string) => void;
  onError: (message: string) => void;
  label: (zh: string, en: string) => string;
}
interface Pending { from: number; to: number; cancelled: boolean }
interface Owner { pending: Set<Pending>; alive: boolean; options: InputOptions }
const owners = new WeakMap<EditorView, Owner>();
const MAX_NATIVE_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

export async function insertMarkdownImages(view: EditorView, files: Blob[], range?: { from: number; to: number }): Promise<void> {
  const owner = owners.get(view);
  if (!owner || view.state.readOnly || !files.length) return;
  const options = owner.options;
  const pending: Pending = { from: range?.from ?? view.state.selection.main.from, to: range?.to ?? view.state.selection.main.to, cancelled: false };
  owner.pending.add(pending);
  options.onStatus(options.label("正在保存图片…", "Saving images…"));
  try {
    const links: string[] = [];
    for (const file of files) {
      if (!owner.alive || pending.cancelled) return;
      const result = await saveMarkdownImage(options.docPath, file, options.preferences());
      links.push(result.markdown);
    }
    if (!owner.alive || pending.cancelled || view.state.readOnly) return;
    view.dispatch({ changes: { from: pending.from, to: pending.to, insert: links.join("\n") + "\n" },
      selection: EditorSelection.cursor(pending.from + links.join("\n").length + 1),
      annotations: [Transaction.userEvent.of("input.paste"), isolateHistory.of("full")] });
    options.onStatus(options.label("图片已保存，已插入相对路径", "Images saved; relative links inserted"));
  } catch (error) {
    if (owner.alive) {
      options.onStatus("");
      options.onError(error instanceof Error ? error.message : String(error));
    }
  } finally { owner.pending.delete(pending); }
}

export function markdownInput(options: InputOptions): Extension {
  return [ViewPlugin.define((view) => {
    const owner: Owner = { pending: new Set(), alive: true, options };
    owners.set(view, owner);
    return {
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        for (const pending of owner.pending) {
          // Deleting the entire insertion context cancels the late insert,
          // rather than resurrecting content the user has explicitly removed.
          update.changes.iterChangedRanges((from, to) => {
            if (to > from && from <= pending.from && to >= pending.to) pending.cancelled = true;
          });
          pending.from = update.changes.mapPos(pending.from, 1);
          pending.to = update.changes.mapPos(pending.to, 1);
        }
      },
      destroy() { owner.alive = false; owner.pending.forEach((pending) => { pending.cancelled = true; }); owners.delete(view); },
    };
  }), EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) return false;
      const data = event.clipboardData;
      if (!data) return false;
      const itemImages = Array.from(data.items).filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
      // WebKit/Tauri can expose an OS image through DataTransfer.files while
      // leaving clipboardData.items empty. Prefer items when available, then
      // use the standards-backed files list without synthesizing an event.
      const images = itemImages.length ? itemImages : Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (images.length) { event.preventDefault(); void insertMarkdownImages(view, images); return true; }
      // A regular text clipboard already exposes a payload synchronously;
      // avoid an unnecessary native image probe (which may round-trip X11).
      if (data.types?.includes("text/plain") && data.getData("text/plain")) {
        const handled = pasteMarkdownText(view, data, options);
        if (handled) event.preventDefault();
        return handled;
      }
      // WebKitGTK can omit both DataTransfer.items and DataTransfer.files for
      // an image owned by another native process. Keep the paste gesture
      // inside the editor while we ask the native clipboard bridge for the
      // temporary PNG that arboard produced. If the clipboard actually holds
      // text, continue through the same table/plain-text path below.
      if (isTauriRuntime()) {
        event.preventDefault();
        void (async () => {
          try {
            const path = await readNativeClipboardImagePath();
            if (path) {
              const result = await viewerReadBytes(path, MAX_NATIVE_CLIPBOARD_IMAGE_BYTES);
              const blob = new Blob([new Uint8Array(result.bytes)], { type: result.mime || "image/png" });
              await insertMarkdownImages(view, [blob]);
              return;
            }
            if (!pasteMarkdownText(view, data, options)) {
              // The native event was consumed while probing the clipboard;
              // preserve ordinary text paste when no image was available.
              const plain = data.getData("text/plain").replace(/\r\n?/g, "\n");
              if (plain) view.dispatch({ changes: { from: view.state.selection.main.from, to: view.state.selection.main.to, insert: plain },
                selection: EditorSelection.cursor(view.state.selection.main.from + plain.length),
                annotations: [Transaction.userEvent.of("input.paste"), isolateHistory.of("full")] });
            }
          } catch (error) {
            options.onError(error instanceof Error ? error.message : String(error));
          }
        })();
        return true;
      }
      const handled = pasteMarkdownText(view, data, options);
      if (handled) event.preventDefault();
      return handled;
    },
    drop(event, view) {
      if (view.state.readOnly) return false;
      const files = Array.from(event.dataTransfer?.files || []).filter((file) => file.type.startsWith("image/"));
      if (!files.length) return false;
      event.preventDefault();
      const from = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      void insertMarkdownImages(view, files, { from, to: from });
      return true;
    },
  })];
}

function pasteMarkdownText(view: EditorView, data: DataTransfer, options: InputOptions): boolean {
  if (!options.preferences().convertTables) return false;
  // Windows clipboard strings use CRLF, while CM positions count its
  // normalized LF document. Use the exact inserted length for selection and
  // the subsequent conversion transaction, not the clipboard length.
  const plain = data.getData("text/plain").replace(/\r\n?/g, "\n");
  const converted = convertTablePaste(data.getData("text/html"), plain);
  if (!converted) return false;
  if (converted.warning) {
    options.onStatus(options.label("合并或嵌套表格已降级为纯文本", "Merged or nested table pasted as plain text"));
    if (plain) return false;
  }
  const from = view.state.selection.main.from;
  // Two intentionally isolated history steps: Undo conversion once yields
  // the original plain clipboard text; another Undo removes the paste.
  const original = plain || converted.markdown;
  view.dispatch({ changes: { from, to: view.state.selection.main.to, insert: original },
    selection: EditorSelection.cursor(from + original.length),
    annotations: [Transaction.userEvent.of("input.paste"), isolateHistory.of("full")] });
  if (original !== converted.markdown) view.dispatch({ changes: { from, to: from + original.length, insert: converted.markdown },
    selection: EditorSelection.cursor(from + converted.markdown.length),
    annotations: [Transaction.userEvent.of("input.paste"), isolateHistory.of("full")] });
  if (!converted.warning) options.onStatus(options.label("已转换为 Markdown 表格；撤销一次恢复纯文本", "Converted to Markdown table; Undo once restores plain text"));
  return true;
}
