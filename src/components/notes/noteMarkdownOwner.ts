import { bytesDataUrl, markdownImageBytes, readMarkdownImage } from "../../lib/markdownAssets";
import { exportMarkdown } from "../viewer/markdown/markdownExport";
import type { MarkdownDocumentOwner } from "../viewer/markdown/markdownOwner";

/** A Note has no disk parent. Embedded images travel with its shared draft,
 * conflict/recovery state and export. Relative links cannot use noteId as cwd. */
export function readNoteMarkdownImage(reference: string): Promise<string> {
  if (!/^data:image\//i.test(reference) && !/^(?:[a-z]:[\\/]|\/|file:\/\/)/i.test(reference)) {
    return Promise.reject(new Error("This Note has no image folder. Paste the image to embed it, or use an absolute local image path."));
  }
  return readMarkdownImage("", reference);
}

export function createNoteMarkdownOwner(options: {
  filename: () => string; onChange: (content: string) => void; onSave: () => Promise<unknown> | void;
}): MarkdownDocumentOwner {
  const assets = {
    readImage: readNoteMarkdownImage,
    saveImage: async (file: Blob) => ({ markdown: `![image](${bytesDataUrl(await markdownImageBytes(file), "image/png")})` }),
    revealImage: () => { throw new Error("Embedded Note images have no containing folder. Export the Note with its images first."); },
  };
  return { ...assets, onChange: options.onChange, onSave: options.onSave,
    onExport: (kind, content, settings) => exportMarkdown(kind, content, options.filename(), settings, assets, false),
  };
}
