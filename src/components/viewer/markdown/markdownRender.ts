import DOMPurify from "dompurify";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
import { renderMermaid } from "../../editor/workspace/model/mermaid";
import { highlightTree, classHighlighter } from "@lezer/highlight";
import { readMarkdownImage } from "../../../lib/markdownAssets";
import { restoreMarkdownTasks } from "./markdownTasks";
import { enhanceMarkdownMath, replaceMarkdownMath } from "./markdownMath";
import { rememberDiagram } from "./diagramModel";
import { parseDrawio } from "./drawioCodec";
import { rememberDrawio, renderDrawioPage } from "./drawioRender";
import { drawioMissingImagesMessage } from "./drawioImageStyle";
import {
  createMarkdownRenderPlaceholder,
  createMarkdownRenderWarning,
  type MarkdownRenderLabel,
  type MarkdownWarningHandler,
} from "./markdownRenderFallback";
import "./drawio.css";
import "katex/dist/katex.min.css";

// This is presentation enhancement of the existing shared renderer, not a
// second parser. Workspace/chat retain their existing rendering defaults.
export function renderMarkdown(content: string): string {
  const math = replaceMarkdownMath(content);
  return renderFormatted(math.content, "md") ?? "";
}

export interface RenderOwner {
  docPath: string;
  cancelled: () => boolean;
  onResize?: () => void;
  onWarning?: MarkdownWarningHandler;
  theme?: "light" | "dark";
  readImage?: (reference: string) => Promise<string>;
  label?: MarkdownRenderLabel;
}
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

export async function enhanceMarkdown(root: HTMLElement, owner: RenderOwner): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  root.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    const src = image.dataset.fvSource || image.getAttribute("src") || "";
    delete image.dataset.fvSource;
    // Strip before attaching to the live document: never issue a browser
    // request for a relative path or external URL.
    image.removeAttribute("src");
    jobs.push((owner.readImage ? owner.readImage(src) : readMarkdownImage(owner.docPath, src)).then((url) => {
      if (owner.cancelled()) return;
      image.src = url;
      image.onload = () => owner.onResize?.();
    }).catch((error: unknown) => {
      if (owner.cancelled()) return;
      const warning = createMarkdownRenderWarning("image", src, image.alt || src || "Image", error);
      owner.onWarning?.(warning);
      image.replaceWith(createMarkdownRenderPlaceholder(warning, owner.label));
      owner.onResize?.();
    }));
  });
  root.querySelectorAll<HTMLElement>("pre > code").forEach((block) => {
    const language = /(?:language|lang)-([\w-]+)/.exec(block.className)?.[1] || "";
    if (language === "drawio-source") {
      const details = document.createElement("details"); details.className = "fv-md-drawio-source";
      const summary = document.createElement("summary"); summary.textContent = "draw.io · Original source";
      block.parentElement?.replaceWith(details); details.append(summary, block.parentElement || block);
    } else if (language === "drawio") {
      jobs.push((async () => {
        const pages = parseDrawio(block.textContent || "");
        const container = document.createElement("div");
        for (const page of pages) {
          const preview = await renderDrawioPage(page);
          if (owner.cancelled()) return;
          const diagram = document.createElement("div"); diagram.className = "fv-md-drawio";
          diagram.setAttribute("aria-label", page.name);
          diagram.innerHTML = preview.svg;
          if (preview.missingImages) {
            const message = drawioMissingImagesMessage(preview.missingImages);
            const warning = createMarkdownRenderWarning("drawio", block.textContent || "", page.name, message);
            owner.onWarning?.(warning);
            const notice = document.createElement("p");
            notice.className = "fv-md-drawio-image-notice";
            notice.textContent = message;
            diagram.append(notice);
          }
          rememberDrawio(diagram, page); container.append(diagram);
        }
        if (!owner.cancelled()) { block.parentElement?.replaceWith(container); owner.onResize?.(); }
      })().catch((error: unknown) => {
        if (owner.cancelled()) return;
        const warning = createMarkdownRenderWarning("drawio", block.textContent || "", "draw.io diagram", error);
        owner.onWarning?.(warning);
        block.parentElement?.replaceWith(createMarkdownRenderPlaceholder(warning, owner.label));
        owner.onResize?.();
      }));
    } else if (language === "mermaid") {
      const source = block.textContent || "";
      // SVG text labels survive our SVG-only sanitizer and rasterize into Word
      // and PNG. Mermaid's default HTML labels use foreignObject, which the
      // sanitizer intentionally removes. This is view-only configuration; the
      // document retains its exact standard Mermaid fence/source.
      jobs.push(renderMermaid(`fv-md-diagram-${++diagramId}`, source, owner.theme).then((result) => {
        if (owner.cancelled()) return;
        const diagram = document.createElement("div");
        diagram.className = "fv-md-mermaid";
        diagram.innerHTML = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } }) as string;
        rememberDiagram(diagram, { source, theme: owner.theme ?? "light" });
        block.parentElement?.replaceWith(diagram);
        owner.onResize?.();
      }).catch((error: unknown) => {
        if (owner.cancelled()) return;
        const warning = createMarkdownRenderWarning("mermaid", source, "Mermaid diagram", error);
        owner.onWarning?.(warning);
        block.parentElement?.replaceWith(createMarkdownRenderPlaceholder(warning, owner.label));
        owner.onResize?.();
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
  restoreMarkdownTasks(root, content);
  enhanceMarkdownMath(root, replaceMarkdownMath(content).formulas);
  return root;
}
