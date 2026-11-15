/** Browser-only boundary: intentionally do not re-export docx's Node typings. */
export interface RunOptions {
  text?: string;
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  font?: string;
  size?: number;
  break?: number;
  children?: Array<string | number>;
}
export class TextRun { constructor(options: string | RunOptions); readonly kind: "run" }
export class ImageRun { constructor(options: { type: "png"; data: Uint8Array; transformation: { width: number; height: number }; altText?: { title: string; description: string; name: string } }); readonly kind: "image" }
export class ExternalHyperlink { constructor(options: { link: string; children: ParagraphChild[] }); readonly kind: "hyperlink" }
export type ParagraphChild = TextRun | ImageRun | ExternalHyperlink;
export interface ParagraphOptions {
  children?: ParagraphChild[];
  heading?: string;
  bullet?: { level: number };
  numbering?: { reference: string; level: number };
  alignment?: string;
  indent?: { left: number; hanging?: number };
  border?: { left: { color: string; size: number; style: string; space: number } };
  shading?: { fill: string };
  spacing?: { before: number; after: number };
}
export class Paragraph { constructor(options: string | ParagraphOptions); readonly kind: "paragraph" }
export class TableCell { constructor(options: { children: Paragraph[] }); readonly kind: "cell" }
export class TableRow { constructor(options: { children: TableCell[]; tableHeader?: boolean }); readonly kind: "row" }
export class Table { constructor(options: { rows: TableRow[]; width: { size: number; type: string } }); readonly kind: "table" }
export class Header { constructor(options: { children: Paragraph[] }); readonly kind: "header" }
export class Footer { constructor(options: { children: Paragraph[] }); readonly kind: "footer" }
export interface DocumentOptions {
  title: string;
  numbering: { config: Array<{ reference: string; levels: Array<{ level: number; format: string; text: string; alignment: string; style: { paragraph: { indent: { left: number; hanging: number } } } }> }> };
  sections: Array<{
    properties: { page: { size: { width: number; height: number; orientation: string }; margin: { top: number; bottom: number; left: number; right: number } } };
    headers?: { default: Header };
    footers?: { default: Footer };
    children: Array<Paragraph | Table>;
  }>;
}
export class Document { constructor(options: DocumentOptions); readonly kind: "document" }
export const Packer: { toBlob(document: Document): Promise<Blob> };
export const PageNumber: { CURRENT: string };
export const WidthType: { PERCENTAGE: string };
export const HeadingLevel: { HEADING_1: string; HEADING_2: string; HEADING_3: string; HEADING_4: string; HEADING_5: string; HEADING_6: string };
export const BorderStyle: { SINGLE: string };
export const LevelFormat: { DECIMAL: string };
export const AlignmentType: { START: string; CENTER: string };
export const PageOrientation: { LANDSCAPE: string; PORTRAIT: string };
