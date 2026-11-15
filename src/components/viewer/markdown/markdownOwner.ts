import type { MarkdownExportKind, MarkdownExportSettings } from "./exportModel";
import type { MarkdownExportResult } from "./markdownExport";

/** Sources own persistence and assets; the Markdown UI owns only presentation.
 * Notes use a stable note identity, never a synthetic path as a disk file. */
export interface MarkdownAssets {
  readImage?: (reference: string) => Promise<string>;
  saveImage?: (file: Blob) => Promise<{ markdown: string }>;
  revealImage?: (reference: string) => void;
}

export interface MarkdownDocumentOwner extends MarkdownAssets {
  onChange: (content: string) => void;
  onSave: () => Promise<unknown> | void;
  onExport?: (kind: MarkdownExportKind, content: string, settings: MarkdownExportSettings) => Promise<MarkdownExportResult>;
}
