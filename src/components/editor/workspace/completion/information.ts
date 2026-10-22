import { renderFormatted } from "../../../../lib/chat/renderFormatted";
import type { LspCompletionItem } from "../../../../lib/editor/lsp";
import { type CompletionItemResolver, type CompletionRequestToken } from "./types";


export async function completionInfo(
  item: LspCompletionItem,
  resolve: CompletionItemResolver | undefined,
  token: CompletionRequestToken,
  isStillCurrent: (token: CompletionRequestToken) => boolean,
): Promise<Node | null> {
  let documentation = item.documentation;
  let detail = item.detail;
  if (!documentation && resolve) {
    try {
      // Resolve may only run while the request identity still matches the
      // live buffer; stale popup docs from a previous file/session are
      // dropped instead of rendered.
      if (!isStillCurrent(token)) {
        if (!detail) return null;
        documentation = null;
      } else {
        const response = await resolve();
        if (!isStillCurrent(token)) return null;
        const resolved = response && typeof response.kind === "string"
          ? response.kind === "resolved" ? response.item : null
          : response;
        documentation = resolved?.documentation ?? null;
        detail = detail ?? resolved?.detail ?? null;
      }
    } catch {
      // Keep whatever we already have.
    }
  }
  if (!documentation && !detail) return null;
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover taomni-chat-md";
  if (detail && detail !== item.label) {
    const detailEl = document.createElement("div");
    detailEl.style.fontFamily = "var(--taomni-code-font-family, monospace)";
    detailEl.style.marginBottom = documentation ? "6px" : "0";
    detailEl.textContent = detail;
    dom.appendChild(detailEl);
  }
  if (documentation) {
    const docEl = document.createElement("div");
    docEl.innerHTML = renderFormatted(documentation, "md") ?? "";
    dom.appendChild(docEl);
  }
  return dom;
}
