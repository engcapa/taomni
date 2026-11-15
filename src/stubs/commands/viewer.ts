import { vfsMkdir, vfsReadBytes, vfsRemove, vfsStat, vfsWriteBytes, parentOf, VFS_ROOT } from "../localVfs";
import { decodeStubBytes, encodeStubText, sha256Bytes } from "./workspace/encoding";
import { VIEWER_IMAGE_LIMIT, VIEWER_TEXT_EDIT_LIMIT, VIEWER_TEXT_HARD_LIMIT } from "../../lib/viewer";
import type { ViewerEol } from "../../lib/viewer";
import { createHtmlResourceLoader } from "./viewerHtmlResources";

const htmlSessions = new Map<string, string[]>();
const temporaryFiles = new Map<string, string>();
const writes = new Map<string, Promise<unknown>>();
function mime(path: string): string {
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", html: "text/html", htm: "text/html", css: "text/css", js: "application/javascript", json: "application/json" };
  return types[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text/plain";
}
function eol(text: string): ViewerEol {
  const endings = new Set(text.match(/\r\n|\r|\n/g) ?? []);
  return endings.size > 1 ? "mixed" : endings.has("\r\n") ? "CRLF" : endings.has("\r") ? "CR" : "LF";
}
function validateName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/\x00-\x1f<>:"|?*]/.test(name) || /[. ]$/.test(name)) throw new Error("permission: Invalid file name");
}
function encodingFor(bytes: Uint8Array, encoding?: string): string {
  return encoding ?? (bytes[0] === 0xff && bytes[1] === 0xfe ? "UTF-16LE" : bytes[0] === 0xfe && bytes[1] === 0xff ? "UTF-16BE" : "UTF-8");
}
function bytePrefix(bytes: Uint8Array, maximum: number, encoding: string): { content: string; offset: number; bom: boolean } {
  let end = Math.min(bytes.length, maximum);
  for (let trim = 0; trim < 8 && end >= 0; trim++, end--) {
    try { const decoded = decodeStubBytes(bytes.slice(0, end), encoding); return { content: decoded.text, offset: end, bom: decoded.bom }; }
    catch { if (bytes.length <= maximum) break; }
  }
  throw new Error("binary: File cannot be decoded as text without data loss");
}
async function exists(path: string): Promise<boolean> { try { await vfsStat(path); return true; } catch { return false; } }
async function ensureDirectory(path: string): Promise<void> {
  if (await exists(path)) return;
  const parent = parentOf(path);
  if (parent && parent !== path) await ensureDirectory(parent);
  await vfsMkdir(path);
}
async function read(path: string, maximum: number, encoding?: string) {
  const [stat, raw] = await Promise.all([vfsStat(path), vfsReadBytes(path)]);
  const bytes = new Uint8Array(raw);
  const label = encodingFor(bytes, encoding);
  const decoded = bytePrefix(bytes, Math.min(maximum, VIEWER_TEXT_HARD_LIMIT), label);
  if (decoded.content.includes("\0")) throw new Error("binary: Binary file");
  const truncated = decoded.offset < bytes.length;
  return { path, content: decoded.content, hash: truncated ? "" : await sha256Bytes(bytes), encoding: label, bom: decoded.bom,
    eol: eol(decoded.content), mtime: stat.mtime, size: stat.size, truncated, nextOffset: decoded.offset };
}
/** Browser-only simulation. Native protocol, IPC and filesystem security are
 * separately tested; this adapter never claims their evidence. */
async function htmlOpen(path: string, allowScripts: boolean) {
  const root = parentOf(path);
  const token = crypto.randomUUID();
  const urls: string[] = [];
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const dom = new DOMParser().parseFromString(new TextDecoder().decode(await vfsReadBytes(path)), "text/html");
  dom.querySelectorAll("base,meta[http-equiv='refresh' i],meta[http-equiv='content-security-policy' i],iframe,object,embed").forEach((node) => node.remove());
  const resources = createHtmlResourceLoader(root);
  for (const element of dom.querySelectorAll("script")) {
    const source = element.getAttribute("src");
    if (!allowScripts) { element.remove(); continue; }
    if (source !== null) {
      const code = await resources.script(source);
      if (code === null) { element.remove(); continue; }
      element.removeAttribute("src");
      element.removeAttribute("integrity");
      element.removeAttribute("crossorigin");
      // Parsed inline text keeps execution in the opaque child; escaping a
      // closing tag prevents a local JS string from altering the serialized DOM.
      element.textContent = code.replace(/<\/script/gi, "<\\/script");
    }
    element.setAttribute("nonce", nonce);
  }
  for (const element of dom.querySelectorAll("style")) element.textContent = await resources.rewriteCss(element.textContent ?? "");
  for (const element of dom.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (!allowScripts && /^on/i.test(attribute.name)) element.removeAttributeNode(attribute);
    }
    if (element.hasAttribute("style")) element.setAttribute("style", await resources.rewriteCss(element.getAttribute("style")!));
    if (element.tagName === "A" || element.tagName === "SCRIPT") continue;
    element.removeAttribute("srcset");
    for (const attribute of ["src", "href"]) {
      const href = element.getAttribute(attribute);
      if (!href) continue;
      // Only known VFS resources become self-contained data. Neither the
      // network opt-in nor the opaque child can fetch parent-origin blobs.
      const url = await resources.asset(href);
      if (url) element.setAttribute(attribute, url); else element.removeAttribute(attribute);
    }
  }
  const bridge = dom.createElement("script");
  // DOMParser documents can have no browsing context; assigning the nonce
  // property there did not serialize an attribute in hosted Chromium. The blob
  // reparses this markup, so its CSP needs the nonce in the serialized HTML.
  bridge.setAttribute("nonce", nonce);
  bridge.textContent = `(()=>{const send=(kind,data={})=>parent.postMessage({type:'taomni-html-preview',token:${JSON.stringify(token)},kind,...data},'*');for(const level of ['log','warn','error','info']){const original=console[level];console[level]=(...args)=>{send('console',{level,message:args.map(String).join(' ')});original.apply(console,args)}}addEventListener('error',event=>send('console',{level:'error',message:event.message}));addEventListener('securitypolicyviolation',event=>send('blocked',{message:event.blockedURI}));document.addEventListener('click',event=>{const anchor=event.target.closest?.('a');if(!anchor)return;event.preventDefault();const href=anchor.getAttribute('href');if(href)send(/^https?:/i.test(href)?'external':'navigate',{href})},true);send('console',{level:'info',message:'Local sandbox ready'})})()`;
  dom.head.prepend(bridge);
  const policy = dom.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  // Allow only embedded, known local resources. Native proxy transport is not
  // available here, so allow-once never turns into direct browser networking.
  policy.content = `default-src 'none'; script-src ${allowScripts ? "'unsafe-inline'" : `'nonce-${nonce}'`}; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  dom.head.prepend(policy);
  const url = URL.createObjectURL(new Blob([`<!doctype html>${dom.documentElement.outerHTML}`], { type: "text/html" }));
  urls.push(url); htmlSessions.set(token, urls);
  return { url, token };
}

export async function invokeViewer(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const path = String(args.path ?? "");
  switch (command) {
    case "viewer_stat": {
      const stat = await vfsStat(path);
      return { path: stat.path, size: stat.size, mtime: stat.mtime, mime: mime(path), isFile: stat.fileType === "file" };
    }
    case "viewer_read_text": return read(path, Number(args.maxBytes ?? VIEWER_TEXT_EDIT_LIMIT), args.encoding as string | undefined);
    case "viewer_read_bytes": {
      const bytes = new Uint8Array(await vfsReadBytes(path));
      if (bytes.length > Math.min(Number(args.maxBytes ?? VIEWER_IMAGE_LIMIT), VIEWER_IMAGE_LIMIT)) throw new Error("too_large: File exceeds byte limit");
      return { bytes: Array.from(bytes), mime: mime(path), size: bytes.length };
    }
    case "viewer_write_text": {
      if (temporaryFiles.has(path)) throw new Error("permission: Save the read-only temporary copy locally before editing");
      const previous = writes.get(path) ?? Promise.resolve();
      const task = previous.catch(() => undefined).then(async () => {
        const bytes = new Uint8Array(await vfsReadBytes(path));
        const hash = await sha256Bytes(bytes);
        if (!args.expectedHash || hash !== args.expectedHash) throw new Error("conflict: File changed on disk");
        let text = String(args.content ?? "");
        if (args.eol !== "mixed") text = text.replace(/\r\n|\r|\n/g, args.eol === "CRLF" ? "\r\n" : args.eol === "CR" ? "\r" : "\n");
        const output = encodeStubText(text, String(args.encoding ?? "UTF-8"), args.bom === true);
        if (output.length > VIEWER_TEXT_HARD_LIMIT) throw new Error("too_large: Editing exceeds 20 MB");
        await vfsWriteBytes(path, output.buffer as ArrayBuffer);
        return { hash: await sha256Bytes(output), size: output.length, mtime: (await vfsStat(path)).mtime };
      });
      writes.set(path, task);
      try { return await task; } finally { if (writes.get(path) === task) writes.delete(path); }
    }
    case "viewer_read_text_chunk": {
      const bytes = new Uint8Array(await vfsReadBytes(path));
      const offset = Number(args.offset ?? 0);
      const prefix = bytePrefix(bytes.slice(offset), Number(args.maxBytes ?? 256 * 1024), String(args.encoding ?? "UTF-8"));
      return { content: prefix.content, nextOffset: offset + prefix.offset, eof: offset + prefix.offset >= bytes.length };
    }
    case "viewer_save_pasted_image": {
      const docPath = String(args.docPath);
      await vfsStat(docPath);
      const directory = String(args.dir ?? "assets");
      const parts = directory.replace(/\\/g, "/").split("/");
      if (parts.some((part) => !part || part === "." || part === "..") || /^[a-z]:/i.test(directory)) throw new Error("permission: Image directory must stay beside the document");
      let dir = parentOf(docPath);
      for (const part of parts) { validateName(part); dir += `/${part}`; await ensureDirectory(dir); }
      const fileName = String(args.fileName); validateName(fileName);
      let target = `${dir}/${fileName}`;
      for (let index = 1; await exists(target); index++) target = `${dir}/${fileName.replace(/\.[^.]+$/, "")}-${index}.png`;
      await vfsWriteBytes(target, new Uint8Array(args.bytes as number[]).buffer);
      return { path: target, relativePath: target.slice(parentOf(docPath).length + 1).split("/").map(encodeURIComponent).join("/") };
    }
    case "viewer_html_open": return htmlOpen(path, args.allowScripts !== false);
    case "viewer_html_close": {
      const token = String(args.token); htmlSessions.get(token)?.forEach((url) => URL.revokeObjectURL(url)); htmlSessions.delete(token); return;
    }
    case "viewer_create_temp": {
      const name = String(args.fileName); validateName(name);
      const token = crypto.randomUUID(); const directory = `${VFS_ROOT}/.viewer-temp/${token}`;
      await ensureDirectory(directory); const target = `${directory}/${name}`;
      await vfsWriteBytes(target, new Uint8Array(args.bytes as number[]).buffer); temporaryFiles.set(target, directory);
      return { path: target, token };
    }
    case "viewer_release_temp": {
      const directory = temporaryFiles.get(path); if (!directory) return;
      await vfsRemove(directory, true); temporaryFiles.delete(path); return;
    }
    default: throw new Error(`Unsupported viewer command: ${command}`);
  }
}
