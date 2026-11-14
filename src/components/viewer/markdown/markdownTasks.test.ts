import { describe, expect, it } from "vitest";
import { markdownFragment } from "./markdownRender";
import { prepareMarkdownExport, DEFAULT_EXPORT_SETTINGS } from "./exportModel";
import { renderFormatted } from "../../../lib/chat/renderFormatted";

const tasks = "- ordinary\n- [ ] **Pending**\n- [x] Completed\n  - [X] Nested done\n";

describe("passive standard Markdown task-state presentation", () => {
  it("preserves checked, unchecked and nested state without adding active inputs or changing chat", () => {
    const root = markdownFragment(tasks);
    expect(Array.from(root.querySelectorAll(".fv-md-task-state")).map((node) => node.textContent)).toEqual(["☐", "☑", "☑"]);
    expect(root.querySelectorAll("li")[0].classList.contains("fv-md-task-item")).toBe(false);
    expect(root.querySelectorAll(".is-checked")).toHaveLength(2);
    expect(root.querySelector("strong")?.textContent).toBe("Pending");
    expect(root.querySelector("input,button,script")).toBeNull();
    expect(renderFormatted(tasks, "md")).not.toContain("fv-md-task-state");
  });
  it("does not mistake ordinary/raw list items or code-fenced checkboxes for tasks", () => {
    const root = markdownFragment("<ul><li>raw</li></ul>\n\n- normal\n- [x] real\n\n```md\n- [ ] code only\n```\n");
    expect(root.querySelectorAll(".fv-md-task-state")).toHaveLength(1);
    expect(root.querySelector(".fv-md-task-state")?.parentElement?.textContent).toContain("real");
    expect(root.querySelector("code")?.textContent).toContain("- [ ] code only");
  });
  it("embeds task symbols and completion styling in the same HTML/PNG/Word export DOM", async () => {
    const prepared = await prepareMarkdownExport(tasks, "/docs/tasks.md", DEFAULT_EXPORT_SETTINGS);
    expect(prepared.root.textContent).toContain("☐");
    expect(prepared.root.textContent).toContain("☑");
    expect(prepared.html).toContain('data-task-checked="false"');
    expect(prepared.html).toContain('data-task-checked="true"');
    expect(prepared.html).toContain(".fv-md-task-item.is-checked");
    expect(prepared.root.querySelector("input,button")).toBeNull();
  });
});
