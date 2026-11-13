// Keep docx's Node-targeted declaration entry (/// reference types="node")
// outside the DOM TypeScript graph. Vite resolves the browser runtime normally;
// the adjacent declaration describes only the browser API used by our adapter.
export {
  Document, Paragraph, TextRun, ImageRun, ExternalHyperlink, Table, TableRow,
  TableCell, Header, Footer, Packer, PageNumber, WidthType, HeadingLevel,
  BorderStyle, LevelFormat, AlignmentType, PageOrientation,
} from "docx";
