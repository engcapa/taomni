import { markdownLanguage } from "@codemirror/lang-markdown";
import { marked, type Tokens } from "marked";
import { explorerCanonicalPath, localCreateEntry } from "../../../lib/explorer";
import { explorerPathKey } from "../../../lib/explorer/openExplorer";
import { selectSaveDirectory, selectSaveFilePath, writeStreamAbort, writeStreamAppend, writeStreamClose, writeStreamOpen } from "../../../lib/ipc";
import { markdownBasename, readMarkdownImage, encodeMarkdownPath } from "../../../lib/markdownAssets";
import { isTauriRuntime } from "../../../lib/runtime";
import { createMarkdownRenderWarning, markdownImagePlaceholderDataUrl } from "./markdownRenderFallback";
import { sftpMkdir } from "../../../lib/sftp";
import type { MarkdownAssets } from "./markdownOwner";
import { lastMarkdownExportDirectory, rememberMarkdownExportDirectory } from "./exportDirectory";

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

export async function saveExportBlob(filename: string, output: Blob | (() => Promise<Blob>), sourcePath?: string): Promise<string | null> {
  const generate = () => typeof output === "function" ? output() : output;
  if (isTauriRuntime()) {
    const path = await selectSaveFilePath(filename, lastMarkdownExportDirectory() ?? sourcePath);
    if (!path) return null;
    // Native streams truncate when opened. Reject the source and canonical
    // aliases/symlinks before touching the selected output, even after overwrite
    // confirmation in the native chooser.
    const source = sourcePath ? explorerPathKey(await explorerCanonicalPath(sourcePath)) : null;
    let target: string;
    try { target = explorerPathKey(await explorerCanonicalPath(path)); }
    catch { target = explorerPathKey(path); }
    if (sourcePath && (source === target || explorerPathKey(sourcePath) === target)) {
      throw new Error("Choose a different output file; the Markdown source is never overwritten");
    }
    // Choose and validate before costly rasterization. Only open the output
    // stream after generation succeeds, so cancellation/errors cannot truncate it.
    const blob = await generate();
    await writeExportBytes(path, new Uint8Array(await blob.arrayBuffer()));
    rememberMarkdownExportDirectory(path);
    return path;
  }
  const url = URL.createObjectURL(await generate());
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

function decodeExportImage(data: string, reference: string): { mime: string; bytes: Uint8Array } {
  const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(data);
  if (!match) throw new Error(`Image data is not supported: ${reference}`);
  try {
    const binary = atob(match[2]);
    return { mime: match[1], bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)) };
  } catch {
    throw new Error(`Image data is not valid base64: ${reference}`);
  }
}

export async function planMarkdownFolder(content: string, docPath: string, assets?: MarkdownAssets): Promise<MarkdownFolderPlan> {
  const references = markdownImageReferences(content);
  const files: MarkdownFolderPlan["files"] = [];
  const destinations = new Map<string, string>();
  let rewritten = content;
  for (const reference of [...references].reverse()) {
    let name = destinations.get(reference.href);
    if (!name) {
      let decoded: { mime: string; bytes: Uint8Array };
      try {
        const data = assets?.readImage ? await assets.readImage(reference.href) : await readMarkdownImage(docPath, reference.href);
        decoded = decodeExportImage(data, reference.href);
      } catch (error) {
        const warning = createMarkdownRenderWarning("image", reference.href, reference.alt || reference.href, error);
        decoded = decodeExportImage(markdownImagePlaceholderDataUrl(warning), reference.href);
      }
      const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp" } as Record<string, string>)[decoded.mime] || "img";
      name = `image-${files.length + 1}.${extension}`;
      files.push({ name, bytes: decoded.bytes }); destinations.set(reference.href, name);
    }
    const alt = reference.alt.replace(/[\\\[\]]/g, "\\$&");
    const replacement = `![${alt}](${encodeMarkdownPath(`assets/${name}`)})`;
    rewritten = rewritten.slice(0, reference.from) + replacement + rewritten.slice(reference.to);
  }
  return { content: rewritten, files };
}

export async function exportMarkdownFolder(content: string, docPath: string, assets?: MarkdownAssets): Promise<string | null> {
  if (!isTauriRuntime()) throw new Error("Markdown + image folder export requires the desktop app");
  const parent = await selectSaveDirectory(lastMarkdownExportDirectory());
  if (!parent) return null;
  const plan = await planMarkdownFolder(content, docPath, assets);
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
    rememberMarkdownExportDirectory(parent, true);
    return folder;
  } catch (error) {
    throw new Error(`Export failed; partial output is retained at ${folder}. ${error instanceof Error ? error.message : String(error)}`);
  }
}
