import type { jsPDF } from "jspdf";
import glyphlessData from "../../../assets/pdf/GlyphLessFont.ttf?inline";

interface FontEntry { id: string; objectNumber?: number; isAlreadyPutted?: boolean }
interface FontOutput {
  font: FontEntry;
  newObject(): number;
  out(value: string): void;
  putStream(options: { data: string; objectId: number; addLength1?: boolean }): void;
}
interface PdfPluginApi {
  getFont(name: string, style: string): FontEntry;
  events: { subscribe(name: string, callback: (output: FontOutput) => void): string };
  write(value: string): void;
}

const cidHex = (value: number) => value.toString(16).padStart(4, "0");
const utf16Hex = (text: string) => Array.from({ length: text.length }, (_, index) => cidHex(text.charCodeAt(index))).join("");

/** Tesseract-style glyphless embedded font: appearance comes from the page
 * image, while each CID maps back to the exact original Unicode grapheme.
 * This includes supplementary-plane characters and needs no system fonts. */
export function createPdfSearchFont(pdf: jsPDF) {
  const data = glyphlessData.split(",")[1];
  if (!data) throw new Error("Embedded PDF search font is unavailable");
  const embeddedFont = atob(data);
  const api = pdf.internal as unknown as PdfPluginApi;
  // This exporter draws all visible content as images. Reserve its otherwise
  // unused Courier resource for the search font; no global jsPDF state changes.
  const font = api.getFont("courier", "normal");
  const characters = new Map<string, number>();
  const encode = (text: string) => {
    let cid = characters.get(text);
    if (cid === undefined) {
      if (characters.size >= 65534) throw new Error("PDF exceeds the 65,534 unique text-cluster limit; split the document");
      cid = characters.size + 1;
      characters.set(text, cid);
    }
    return cidHex(cid);
  };
  api.events.subscribe("putFont", ({ font: current, newObject, out, putStream }) => {
    if (current !== font) return;
    const stream = (data: string, addLength1 = false) => {
      const id = newObject();
      putStream({ data, objectId: id, addLength1 });
      out("endobj");
      return id;
    };
    const dictionary = (value: string) => { const id = newObject(); out(value); out("endobj"); return id; };
    const file = stream(embeddedFont, true);
    const entries = Array.from(characters, ([text, cid]) => `<${cidHex(cid)}> <${utf16Hex(text)}>`);
    const mappings: string[] = [];
    for (let index = 0; index < entries.length; index += 100) {
      const chunk = entries.slice(index, index + 100);
      mappings.push(`${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar`);
    }
    const unicode = stream(`/CIDInit /ProcSet findresource begin
12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /TaomniSearchUnicode def /CMapType 2 def
1 begincodespacerange <0000> <ffff> endcodespacerange
${mappings.join("\n")}
endcmap CMapName currentdict /CMap defineresource pop end end`);
    const glyphMap = stream("\x00\x01".repeat(characters.size + 1));
    const descriptor = dictionary(`<< /Type /FontDescriptor /FontName /TaomniSearch
/Flags 5 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 1000 /Descent 0
/CapHeight 1000 /StemV 80 /FontFile2 ${file} 0 R >>`);
    const descendant = dictionary(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TaomniSearch
/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>
/FontDescriptor ${descriptor} 0 R /DW 1000 /CIDToGIDMap ${glyphMap} 0 R >>`);
    current.objectNumber = dictionary(`<< /Type /Font /Subtype /Type0 /BaseFont /TaomniSearch
/Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${unicode} 0 R >>`);
    current.isAlreadyPutted = true;
  });
  return {
    /** Coordinates and font size are PDF points, independent of jsPDF's unit. */
    write(text: string, x: number, bottom: number, width: number, height: number, pageHeight: number) {
      const cid = encode(text);
      const number = (value: number) => value.toFixed(5);
      api.write(`q BT /${font.id} ${number(height)} Tf 3 Tr ${number(100 * width / height)} Tz 1 0 0 1 ${number(x)} ${number(pageHeight - bottom)} Tm <${cid}> Tj ET Q`);
    },
  };
}

export type PdfSearchFont = ReturnType<typeof createPdfSearchFont>;
