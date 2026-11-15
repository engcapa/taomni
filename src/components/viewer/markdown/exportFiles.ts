import { markdownLanguage } from "@codemirror/lang-markdown";
import { marked, type Tokens } from "marked";
import { explorerCanonicalPath, localCreateEntry } from "../../../lib/explorer";
import { explorerPathKey } from "../../../lib/explorer/openExplorer";
import { selectSaveDirectory, selectSaveFilePath, writeStreamAbort, writeStreamAppend, writeStreamClose, writeStreamOpen } from "../../../lib/ipc";
import { markdownBasename, readMarkdownImage, resolveMarkdownAsset, encodeMarkdownPath } from "../../../lib/markdownAssets";
import { isTauriRuntime } from "../../../lib/runtime";
import { sftpMkdir } from "../../../lib/sftp";

export async function writeExportBytes(path: string, bytes: Uint8Array): Promise<void> {
  let handle: string | null = null;
  try {
    handle = await writeStreamOpen(path);
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) await writeStreamAppend(handle, bytes.subarray(offset, offset + 256 * 1024));
    await writeStreamClose(handle);
  } catch (error) {
    if (handle) await writeStreamAbort(handle).catch(() => undefined);
    throw error;
  }
}

export async function saveExportBlob(filename: string, blob: Blob, sourcePath: string): Promise<string | null> {
  if (isTauriRuntime()) {
    const path = await selectSaveFilePath(filename, sourcePath);
    if (!path) return null;
    // Native streams truncate when opened. Reject the source and canonical
    // aliases/symlinks before touching the selected output, even after overwrite
    // confirmation in the native chooser.
    const source = explorerPathKey(await explorerCanonicalPath(sourcePath));
    let target: string;
    try { target = explorerPathKey(await explorerCanonicalPath(path)); }
    catch { target = explorerPathKey(path); }
    if (source === target || explorerPathKey(sourcePath) === target) {
      throw new Error("Choose a different output file; the Markdown source is never overwritten");
    }
    await writeExportBytes(path, new Uint8Array(await blob.arrayBuffer()));
    return path;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

export interface ExportImageReference { from: number; to: number; raw: string; href: string; alt: string }
export function markdownImageReferences(content: string): ExportImageReference[] {
  const images = new Map<string, Tokens.Image>();
  marked.walkTokens(marked.lexer(content, { gfm: true }), (token) => { if (token.type === "image") images.set(token.raw, token as Tokens.Image); });
  const references: ExportImageReference[] = [];
  markdownLanguage.parser.parse(content).iterate({ enter(node) {
    if (node.name !== "Image") return;
    const raw = content.slice(node.from, node.to);
    const image = images.get(raw);
    if (image) references.push({ from: node.from, to: node.to, raw, href: image.href, alt: image.text });
    return false;
  } });
  return references;
}

export interface MarkdownFolderPlan { content: string; files: Array<{ name: string; bytes: Uint8Array }> }
export async function planMarkdownFolder(content: string, docPath: string): Promise<MarkdownFolderPlan> {
  const references = markdownImageReferences(content);
  const files: MarkdownFolderPlan["files"] = [];
  const destinations = new Map<string, string>();
  let rewritten = content;
  for (const reference of [...references].reverse()) {
    if (!resolveMarkdownAsset(docPath, reference.href) && !reference.href.startsWith("data:image/")) {
      throw new Error(`Remote image cannot be bundled. Save it locally first: ${reference.href}`);
    }
    let name = destinations.get(reference.href);
    if (!name) {
      const data = await readMarkdownImage(docPath, reference.href);
      const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(data);
      if (!match) throw new Error(`Image data is not supported: ${reference.href}`);
      const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp" } as Record<string, string>)[match[1]] || "img";
      name = `image-${files.length + 1}.${extension}`;
      const binary = atob(match[2]);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      files.push({ name, bytes }); destinations.set(reference.href, name);
    }
    const alt = reference.alt.replace(/[\\\[\]]/g, "\\$&");
    const replacement = `![${alt}](${encodeMarkdownPath(`assets/${name}`)})`;
    rewritten = rewritten.slice(0, reference.from) + replacement + rewritten.slice(reference.to);
  }
  return { content: rewritten, files };
}

export async function exportMarkdownFolder(content: string, docPath: string): Promise<string | null> {
  if (!isTauriRuntime()) throw new Error("Markdown + image folder export requires the desktop app");
  const parent = await selectSaveDirectory();
  if (!parent) return null;
  const plan = await planMarkdownFolder(content, docPath);
  const filename = markdownBasename(docPath);
  // localCreateEntry atomically numbers collisions. Never overwrite an
  // existing folder, source document, or previously exported image.
  const folder = await localCreateEntry(parent, filename.replace(/\.(md|markdown)$/i, "") || "markdown", true);
  try {
    if (plan.files.length) {
      await sftpMkdir("", `${folder}/assets`, "local");
      for (const file of plan.files) await writeExportBytes(`${folder}/assets/${file.name}`, file.bytes);
    }
    await writeExportBytes(`${folder}/${filename}`, new TextEncoder().encode(plan.content));
    return folder;
  } catch (error) {
    throw new Error(`Export failed; partial output is retained at ${folder}. ${error instanceof Error ? error.message : String(error)}`);
  }
}
