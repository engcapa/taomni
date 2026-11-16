import { expect, it, vi } from "vitest";
import { createNoteMarkdownOwner, readNoteMarkdownImage } from "./noteMarkdownOwner";
import { viewerSavePastedImage } from "../../lib/viewer";
import { exportMarkdown } from "../viewer/markdown/markdownExport";
import { DEFAULT_EXPORT_SETTINGS } from "../viewer/markdown/exportModel";

vi.mock("../../lib/viewer", async (original) => ({ ...await original<typeof import("../../lib/viewer")>(), viewerSavePastedImage: vi.fn() }));
vi.mock("../viewer/markdown/markdownExport", () => ({ exportMarkdown: vi.fn(async () => ({ status: "saved" })) }));

it("embeds pasted Note assets in its content without writing beside a synthetic noteId path", async () => {
  const owner = createNoteMarkdownOwner({ filename: () => "Note.md", onChange: vi.fn(), onSave: vi.fn() });
  const file = new Blob([Uint8Array.of(137, 80, 78, 71)], { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => Uint8Array.of(137, 80, 78, 71).buffer });
  const image = await owner.saveImage!(file);
  expect(image.markdown).toBe("![image](data:image/png;base64,iVBORw==)");
  expect(await owner.readImage!("data:image/png;base64,iVBORw==")).toBe("data:image/png;base64,iVBORw==");
  expect(viewerSavePastedImage).not.toHaveBeenCalled();
  await expect(readNoteMarkdownImage("assets/a.png")).rejects.toThrow("no image folder");
  await owner.onExport!("docx", "# Note", DEFAULT_EXPORT_SETTINGS);
  expect(exportMarkdown).toHaveBeenCalledWith("docx", "# Note", "Note.md", DEFAULT_EXPORT_SETTINGS, expect.objectContaining({ readImage: expect.any(Function) }), false);
});
