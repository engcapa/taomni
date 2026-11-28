import PptxGenJS from "pptxgenjs";

export async function createPresentation(title, subtitle) {
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  deck.title = title;
  deck.theme = { headFontFace: "Arial", bodyFontFace: "Arial", lang: "en-US" };
  const slide = deck.addSlide();
  slide.addText(title, { x: 0.8, y: 2.1, w: 11.7, h: 1.2, fontSize: 36, bold: true });
  if (subtitle.trim()) {
    slide.addText(subtitle, { x: 0.8, y: 3.6, w: 11.7, h: 1.4, fontSize: 20 });
  }
  return new Uint8Array(await deck.write({ outputType: "arraybuffer", compression: true }));
}
