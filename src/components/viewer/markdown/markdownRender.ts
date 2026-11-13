import DOMPurify from "dompurify";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
import { ensureMermaidReady } from "../../editor/workspace/model/mermaid";
import { highlightTree, classHighlighter } from "@lezer/highlight";
import { readMarkdownImage } from "../../../lib/markdownAssets";

// This is presentation enhancement of the existing shared renderer, not a
// second parser. Workspace/chat retain their existing rendering defaults.
export function renderMarkdown(content: string): string {
  return renderFormatted(content, "md") ?? "";
}

export interface RenderOwner { docPath: string; cancelled: () => boolean; onResize?: () => void }
let diagramId = 0;

async function highlightCode(block: HTMLElement, language: string): Promise<void> {
  // Language parsers are loaded only for blocks actually present in a document.
  let parser: import("@codemirror/language").Language | undefined;
  if (/^(js|javascript|ts|typescript|jsx|tsx)$/.test(language)) {
    const mod = await import("@codemirror/lang-javascript");
    parser = mod.javascript({ typescript: /^(ts|typescript|tsx)$/.test(language), jsx: /x$/.test(language) }).language;
  } else if (language === "rust" || language === "rs") parser = (await import("@codemirror/lang-rust")).rustLanguage;
  else if (language === "json") parser = (await import("@codemirror/lang-json")).jsonLanguage;
  else if (language === "python" || language === "py") parser = (await import("@codemirror/lang-python")).pythonLanguage;
  else if (language === "css") parser = (await import("@codemirror/lang-css")).cssLanguage;
  else if (language === "html") parser = (await import("@codemirror/lang-html")).htmlLanguage;
  else if (language === "sql") parser = (await import("@codemirror/lang-sql")).sql().language;
  if (!parser) return;
  const text = block.textContent || "";
  const fragment = document.createDocumentFragment();
  let offset = 0;
  highlightTree(parser.parser.parse(text), classHighlighter, (from, to, classes) => {
    if (from > offset) fragment.append(text.slice(offset, from));
    const span = document.createElement("span");
    span.className = classes;
    span.textContent = text.slice(from, to);
    fragment.append(span);
    offset = to;
  });
  fragment.append(text.slice(offset));
  block.replaceChildren(fragment);
}

export async function enhanceMarkdown(root: HTMLElement, owner: RenderOwner, strict = false): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  root.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    const src = image.dataset.fvSource || image.getAttribute("src") || "";
    delete image.dataset.fvSource;
    // Strip before attaching to the live document: never issue a browser
    // request for a relative path or external URL.
    image.removeAttribute("src");
    jobs.push(readMarkdownImage(owner.docPath, src).then((url) => {
      if (owner.cancelled()) return;
      image.src = url;
      image.onload = () => owner.onResize?.();
    }).catch((error: unknown) => {
      if (strict) throw error;
      if (owner.cancelled()) return;
      image.classList.add("fv-md-image-error");
      image.alt = `${image.alt || src} — ${error instanceof Error ? error.message : String(error)}`;
      image.title = image.alt;
    }));
  });
  root.querySelectorAll<HTMLElement>("pre > code").forEach((block) => {
    const language = /(?:language|lang)-([\w-]+)/.exec(block.className)?.[1] || "";
    if (language === "mermaid") {
      const source = block.textContent || "";
      jobs.push(ensureMermaidReady().then((mermaid) => mermaid.render(`fv-md-diagram-${++diagramId}`, source)).then((result) => {
        if (owner.cancelled()) return;
        const diagram = document.createElement("div");
        diagram.className = "fv-md-mermaid";
        diagram.innerHTML = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } }) as string;
        block.parentElement?.replaceWith(diagram);
        owner.onResize?.();
      }).catch((error: unknown) => {
        if (strict) throw new Error(`Mermaid: ${error instanceof Error ? error.message : String(error)}`);
        if (owner.cancelled()) return;
        const message = document.createElement("div");
        message.className = "fv-md-render-error";
        message.textContent = `Mermaid: ${error instanceof Error ? error.message : String(error)}`;
        block.parentElement?.append(message);
      }));
    } else if (language) jobs.push(highlightCode(block, language));
  });
  await Promise.all(jobs);
}

/** Parse in an inert template; remove image sources before nodes are attached. */
export function markdownFragment(content: string): HTMLElement {
  const root = document.createElement("div");
  const template = document.createElement("template");
  template.innerHTML = renderMarkdown(content);
  template.content.querySelectorAll("img").forEach((image) => {
    image.dataset.fvSource = image.getAttribute("src") || "";
    image.removeAttribute("src");
  });
  root.append(template.content);
  return root;
}
