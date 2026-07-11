import { useEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
import {
  ensureMermaidReady,
  errorMessage,
  exportMermaidPng,
  exportMermaidSvg,
  hashString,
  type MermaidApi,
  type OpenFileState,
} from "./codeWorkspaceModel";

export function MarkdownPreview({
  file,
  onOpenHref,
}: {
  file: OpenFileState;
  onOpenHref: (href: string) => boolean;
}) {
  const html = useMemo(() => renderFormatted(file.text, "md") ?? "", [file.text]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const blocks = Array.from(root.querySelectorAll("pre > code.language-mermaid, pre > code.lang-mermaid"));
    if (blocks.length === 0) return;
    let cancelled = false;

    const renderError = (block: Element, index: number, message: string) => {
      const pre = block.parentElement;
      if (!pre) return;
      const wrapper = document.createElement("div");
      wrapper.className = "my-3 border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)]";
      const label = document.createElement("div");
      label.className = "h-8 flex items-center border-b border-[var(--taomni-code-border)] px-2 text-[11px] font-semibold text-[var(--taomni-code-muted)]";
      label.textContent = `Mermaid ${index + 1}`;
      const error = document.createElement("div");
      error.className = "p-3 text-[12px] text-red-500";
      error.textContent = message;
      wrapper.append(label, error);
      pre.replaceWith(wrapper);
    };

    const renderBlock = (mermaid: MermaidApi, block: Element, index: number) => {
      const source = block.textContent ?? "";
      const pre = block.parentElement;
      if (!pre) return;
      const wrapper = document.createElement("div");
      wrapper.className = "my-3 border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)]";
      const toolbar = document.createElement("div");
      toolbar.className = "h-8 flex items-center gap-1 border-b border-[var(--taomni-code-border)] px-2";
      const label = document.createElement("span");
      label.className = "min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--taomni-code-muted)]";
      label.textContent = `Mermaid ${index + 1}`;
      const svgButton = document.createElement("button");
      svgButton.type = "button";
      svgButton.className = "h-5 px-1.5 rounded text-[10px] hover:bg-[var(--taomni-code-active-line-bg)]";
      svgButton.textContent = "SVG";
      const pngButton = document.createElement("button");
      pngButton.type = "button";
      pngButton.className = "h-5 px-1.5 rounded text-[10px] hover:bg-[var(--taomni-code-active-line-bg)]";
      pngButton.textContent = "PNG";
      const diagram = document.createElement("div");
      diagram.className = "overflow-auto p-3";
      toolbar.append(label, svgButton, pngButton);
      wrapper.append(toolbar, diagram);
      pre.replaceWith(wrapper);

      void mermaid
        .render(`taomni-mermaid-${hashString(file.key)}-${hashString(source)}-${index}`, source)
        .then((result) => {
          if (cancelled) return;
          diagram.innerHTML = DOMPurify.sanitize(result.svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          }) as unknown as string;
          const svg = diagram.querySelector("svg");
          if (!(svg instanceof SVGSVGElement)) return;
          svg.classList.add("max-w-full");
          svgButton.onclick = () => exportMermaidSvg(svg, `${file.title || "diagram"}-${index + 1}.svg`);
          pngButton.onclick = () => exportMermaidPng(svg, `${file.title || "diagram"}-${index + 1}.png`);
        })
        .catch((err) => {
          if (cancelled) return;
          diagram.className = "p-3 text-[12px] text-red-500";
          diagram.textContent = errorMessage(err);
        });
    };

    void ensureMermaidReady()
      .then((mermaid) => {
        if (cancelled) return;
        blocks.forEach((block, index) => renderBlock(mermaid, block, index));
      })
      .catch((err) => {
        if (cancelled) return;
        blocks.forEach((block, index) => renderError(block, index, errorMessage(err)));
      });

    return () => {
      cancelled = true;
    };
  });

  return (
    <div
      ref={rootRef}
      data-testid="code-workspace-markdown-preview"
      className="taomni-chat-md h-full min-h-0 overflow-auto bg-[var(--taomni-code-bg)] px-5 py-4 text-[length:var(--taomni-code-font-size)] leading-6 text-[var(--taomni-code-text)]"
      onClick={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const anchor = target.closest("a");
        const href = anchor?.getAttribute("href");
        if (!href) return;
        if (onOpenHref(href)) {
          event.preventDefault();
        }
      }}
    >
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
