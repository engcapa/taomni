import PptxGenJS from "pptxgenjs";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { unzipSync, zipSync } from "fflate";
import { fileURLToPath } from "node:url";

// Pass the slides skill's pptxgenjs_helpers directory as the first argument.
const require = createRequire(import.meta.url);
const { warnIfSlideHasOverlaps, warnIfSlideElementsOutOfBounds } = require(process.argv[2] + "/layout.js");
const deck = new PptxGenJS();
deck.layout = "LAYOUT_WIDE";
deck.title = "Quarterly review";
deck.subject = "TaOffice presentation test fixture";
deck.author = "Taomni";
deck.theme = { headFontFace: "Arial", bodyFontFace: "Arial", lang: "en-US" };

function addTitle(slide, text) {
  slide.addText(text, { x: 0.8, y: 0.65, w: 11.7, h: 0.72, fontSize: 28, bold: true, color: "102742" });
}

const review = deck.addSlide();
review.background = { color: "EAF4FF" };
addTitle(review, "Quarterly review");
review.addText([
  { text: "Pilot ", options: { bold: true } },
  { text: "moves with", options: { italic: true } },
  { text: " approval", options: { color: "163963" } },
], { x: 0.8, y: 1.67, w: 11.7, h: 0.65, fontSize: 22, color: "102742" });
review.addShape(deck.ShapeType.rect, { x: 0.8, y: 3, w: 3.2, h: 2.75,
  fill: { color: "214E76" }, line: { color: "214E76" } });
review.addTable([
  ["Workstream", "Status"],
  ["Release", "Ready"],
], { x: 4.5, y: 3, w: 7.5, colW: [3.75, 3.75], h: 1.5, rowH: 0.64,
  margin: 0.16, fontFace: "Arial", fontSize: 17, fill: { color: "FFFFFF" },
  color: "102742", border: { type: "solid", color: "A6BDD2", pt: 1 } });
review.addNotes("Preserve this original speaker note.");

const appendix = deck.addSlide();
appendix.background = { color: "F2F9EF" };
addTitle(appendix, "Delivery appendix");
appendix.addText("Unchanged second slide", { x: 0.8, y: 1.6, w: 11.7, h: 0.7, fontSize: 22, color: "102742" });
appendix.addChart(deck.ChartType.bar, [{ name: "Completed", labels: ["April", "May", "June"], values: [3, 5, 7] }],
  { x: 0.8, y: 2.5, w: 8.2, h: 3.8, barDir: "col", catAxisTitle: "Month", showLegend: false,
    chartColors: ["347845"], showValue: true, showTitle: false });
appendix.addNotes("Keep the appendix chart and its data.");

for (const slide of [review, appendix]) {
  // PptxGenJS stores table positions in EMUs and other positions in inches.
  const geometry = slide._slideObjects.map((object) => {
    if (!object.options || object.options.w < 10000) return object;
    const options = { ...object.options };
    for (const key of ["x", "y", "w", "h"]) {
      if (typeof options[key] === "number") options[key] /= 914400;
    }
    return { ...object, options };
  });
  const view = { ...slide, _slideObjects: geometry };
  const group = { ...deck, _slides: deck._slides.map((entry) => entry === slide ? view : entry) };
  warnIfSlideHasOverlaps(view, group);
  warnIfSlideElementsOutOfBounds(view, group);
}
const file = process.argv[3] ?? fileURLToPath(new URL("./ppt-review.pptx", import.meta.url));
await deck.writeFile({ fileName: file });
// PptxGenJS writes paragraph properties before each styled run. DrawingML
// permits one paragraph-properties element at the start of the paragraph.
const entries = unzipSync(new Uint8Array(await readFile(file)));
const slidePath = "ppt/slides/slide1.xml";
const xml = new TextDecoder().decode(entries[slidePath]);
entries[slidePath] = new TextEncoder().encode(xml.replace(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/gu, (paragraph) => {
  let first = true;
  return paragraph.replace(/<a:pPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:pPr>)/gu, (properties) => {
    if (!first) return "";
    first = false;
    return properties;
  });
}));
await writeFile(file, zipSync(entries, { level: 0 }));
