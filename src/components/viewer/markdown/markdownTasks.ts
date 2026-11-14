import { marked, type Tokens } from "marked";

interface ListItemState { task: boolean; checked: boolean }

/** Restore passive GFM task state after the shared chat sanitizer strips form
 * inputs. This only annotates its existing sanitized list DOM; it never renders
 * Markdown or inserts clipboard/source HTML, and never changes chat behavior. */
export function restoreMarkdownTasks(root: HTMLElement, content: string): void {
  const states: ListItemState[] = [];
  marked.walkTokens(marked.lexer(content, { gfm: true, breaks: true }), (token) => {
    if (token.type === "list_item") {
      const item = token as Tokens.ListItem;
      states.push({ task: item.task, checked: item.checked === true });
    } else if (token.type === "html" && /<li(?:\s|>)/i.test(token.raw)) {
      // Raw HTML list items are not GFM tasks. Count them in the same document
      // order so they cannot shift a later Markdown task onto the wrong item.
      const inert = document.createElement("template");
      inert.innerHTML = token.raw;
      inert.content.querySelectorAll("li").forEach(() => states.push({ task: false, checked: false }));
    }
  });
  const items = Array.from(root.querySelectorAll("li"));
  // Invalid/malformed mixed HTML can be repaired by the browser differently
  // from the Markdown token tree. Never assign a checked state to a wrong item.
  if (items.length !== states.length) return;
  items.forEach((item, index) => {
    const state = states[index];
    if (!state.task) return;
    const marker = document.createElement("span");
    marker.className = "fv-md-task-state";
    marker.textContent = state.checked ? "☑" : "☐";
    marker.dataset.taskChecked = String(state.checked);
    item.classList.add("fv-md-task-item");
    item.classList.toggle("is-checked", state.checked);
    item.prepend(marker);
  });
}
