import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
import { useMarkdownPreviewSearch, type MarkdownPreviewSearchOwner } from "./useMarkdownPreviewSearch";
import {
  errorMessage,
  exportMermaidPng,
  exportMermaidSvg,
  hashString,
  type OpenFileState,
} from "./codeWorkspaceModel";
import { renderMermaid } from "./model/mermaid";
import { PreviewAppearanceControl, previewThemeStyle, usePreviewTheme, type PreviewAppearance } from "../../viewer/markdown/PreviewAppearance";
import "../../viewer/markdown/markdown.css";

type MermaidBlock = {
  source: string;
  index: number;
  wrapper: HTMLDivElement;
  diagram: HTMLDivElement;
  svgButton: HTMLButtonElement;
  pngButton: HTMLButtonElement;
};

export function MarkdownPreview({
  file,
  onOpenHref,
  searchOwner,
}: {
  file: OpenFileState;
  onOpenHref: (href: string) => boolean;
  searchOwner?: MarkdownPreviewSearchOwner;
}) {
  const html = useMemo(() => renderFormatted(file.text, "md") ?? "", [file.text]);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const mermaidBlocks = useRef<MermaidBlock[]>([]);
  const search = useMarkdownPreviewSearch(rootRef, contentRef, html, searchOwner);
  const [appearance, setAppearance] = useState<PreviewAppearance>("auto");
  const theme = usePreviewTheme(appearance);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const blocks = Array.from(root.querySelectorAll("pre > code.language-mermaid, pre > code.lang-mermaid"));
    let cancelled = false;

    const createBlock = (block: Element, index: number): MermaidBlock | null => {
      const source = block.textContent ?? "";
      const pre = block.parentElement;
      if (!pre) return null;
      const wrapper = document.createElement("div");
      wrapper.className = "my-3 border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)]";
      wrapper.style.cssText = "background:var(--code-bg);color:var(--text);border-color:var(--divider)";
      const toolbar = document.createElement("div");
      toolbar.className = "h-8 flex items-center gap-1 border-b border-[var(--taomni-code-border)] px-2";
      const label = document.createElement("span");
      label.className = "min-w-0 flex-1 truncate text-ui-small font-semibold text-[var(--taomni-code-muted)]";
      label.textContent = `Mermaid ${index + 1}`;
      const svgButton = document.createElement("button");
      svgButton.type = "button";
      svgButton.className = "h-5 px-1.5 rounded text-ui-caption hover:bg-[var(--taomni-code-active-line-bg)]";
      svgButton.textContent = "SVG";
      const pngButton = document.createElement("button");
      pngButton.type = "button";
      pngButton.className = "h-5 px-1.5 rounded text-ui-caption hover:bg-[var(--taomni-code-active-line-bg)]";
      pngButton.textContent = "PNG";
      const diagram = document.createElement("div");
      diagram.className = "overflow-auto p-3";
      toolbar.append(label, svgButton, pngButton);
      wrapper.append(toolbar, diagram);
      pre.replaceWith(wrapper);
      return { source, index, wrapper, diagram, svgButton, pngButton };
    };
    // Theme changes replace only completed SVGs. Keep prose/search marks and
    // the old diagram's geometry while the asynchronous render is pending.
    mermaidBlocks.current = [
      ...mermaidBlocks.current.filter(({ wrapper }) => root.contains(wrapper)),
      ...blocks.map(createBlock).filter((block): block is MermaidBlock => block !== null),
    ];
    for (const { source, index, diagram, svgButton, pngButton } of mermaidBlocks.current) {
      void renderMermaid(`taomni-mermaid-${hashString(file.key)}-${hashString(source)}-${index}`, source, theme)
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
          diagram.className = "p-3 text-ui-body text-ui-danger";
          diagram.textContent = errorMessage(err);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [file.key, file.title, html, theme]);

  return (
    <div
      ref={rootRef}
      onFocusCapture={search.onFocusCapture}
      onBlurCapture={search.onBlurCapture}
      tabIndex={-1}
      data-testid="code-workspace-markdown-preview"
      data-preview-theme={theme}
      style={{ ...previewThemeStyle(theme), background: "var(--bg)", color: "var(--text)" }}
      className="taomni-chat-md h-full min-h-0 overflow-auto bg-[var(--taomni-code-bg)] px-5 py-4 text-[length:var(--taomni-code-font-size)] leading-6 text-[var(--taomni-code-text)] focus-visible:keyboard-outline"
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
      {search.toolbar}
      <PreviewAppearanceControl value={appearance} onChange={setAppearance} />
      <div ref={contentRef} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
