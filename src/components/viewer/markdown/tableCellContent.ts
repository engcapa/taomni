import { marked } from "marked";
import { renderFormatted } from "../../../lib/chat/renderFormatted";

/** Only the focused editable cell exposes source. Inactive cells use the same
 * GFM parser and sanitizer as preview, without treating a cell as a block. */
export function updateTableCellContent(cell: HTMLElement, source: string, readOnly: boolean): void {
  if (!readOnly && document.activeElement === cell) {
    if (cell.textContent !== source) cell.textContent = source;
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = renderFormatted(marked.parseInline(source, { async: false }), "html") ?? "";
  // Table widgets don't own asynchronous image loading. Keep their alt text
  // rather than making implicit network requests or exposing broken images.
  template.content.querySelectorAll("img").forEach(image => image.replaceWith(image.alt));
  cell.replaceChildren(template.content);
}
