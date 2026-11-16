import { useEffect, useRef } from "react";
import { enhanceMarkdown, markdownFragment } from "../../viewer/markdown/markdownRender";

/** Reuses the document renderer; chat never resolves arbitrary local image
 * paths unless the user explicitly attached them through its context port. */
export function MarkdownReply({ text }: { text: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    let cancelled = false;
    const fragment = markdownFragment(text);
    root.current.replaceChildren(...Array.from(fragment.childNodes));
    void enhanceMarkdown(root.current, { docPath: "tao-reply.md", cancelled: () => cancelled, theme: document.documentElement.dataset.appTheme === "dark" ? "dark" : "light", readImage: async (src) => {
      if (/^data:image\//i.test(src)) return src;
      throw new Error("Only attached images can be shown in Tao");
    } });
    return () => { cancelled = true; };
  }, [text]);
  return <div className="tao-home-message-markdown fv-markdown" ref={root} data-testid="tao-home-markdown-reply" />;
}
