// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, degrees } from "@cantoo/pdf-lib";
import { changePageLayout, originalPages, sameLayout } from "./pdfEditorState.js";
import { savePdfPageEdits } from "./pdfPageEdits.js";

async function fixture() {
  const pdf = await PDFDocument.create();
  const first = pdf.addPage([240, 320]);
  const second = pdf.addPage([440, 210]);
  const third = pdf.addPage([520, 340]);
  third.setRotation(degrees(90));
  const form = pdf.getForm();
  const shared = form.createTextField("Reviewer");
  shared.setText("Ada");
  shared.addToPage(second);
  shared.addToPage(third);
  form.createCheckBox("Removed").addToPage(second);
  first.drawText("Introduction");
  return pdf.save();
}

describe("PDF page editing", () => {
  it("reorders and removes pages while preserving page identities, surviving widgets and annotations", async () => {
    const source = await fixture();
    const points = [[20, 30], [60, 70]];
    const marks = new Map([[3, [
      { kind: "highlight", points }, { kind: "box", points }, { kind: "ink", points },
      { kind: "note", points: [[8, 19]], text: "原文 − verified" },
    ]]]);
    const copy = await savePdfPageEdits(source, [{ number: 3, rotation: 90 }, { number: 1, rotation: 0 }], marks);
    const result = await PDFDocument.load(copy);
    const [third, first] = result.getPages();
    expect(result.getPageCount()).toBe(2);
    expect(third.getSize()).toEqual({ width: 520, height: 340 });
    expect(third.getRotation().angle).toBe(180);
    expect(first.getSize()).toEqual({ width: 240, height: 320 });
    const form = result.getForm();
    expect(form.getFields().map((field) => field.getName())).toEqual(["Reviewer"]);
    const reviewer = form.getTextField("Reviewer");
    expect(reviewer.getText()).toBe("Ada");
    expect(reviewer.acroField.getWidgets().map((widget) => widget.P())).toEqual([third.ref]);
    const annotations = third.node.Annots().asArray().map((ref) => result.context.lookup(ref));
    expect(annotations.map((item) => item.get(PDFName.of("Subtype")).toString())).toEqual([
      "/Widget", "/Highlight", "/Square", "/Ink", "/Text",
    ]);
    for (const item of annotations.slice(1)) {
      expect(item.get(PDFName.of("P"))).toEqual(third.ref);
      expect(item.lookup(PDFName.of("AP")).lookup(PDFName.of("N")).getContents().length).toBeGreaterThan(0);
    }
    expect(annotations.at(-1).get(PDFName.of("Contents")).decodeText()).toBe("原文 − verified");
    const original = await PDFDocument.load(source);
    expect(original.getPageCount()).toBe(3);
    expect(original.getPage(2).getRotation().angle).toBe(90);
    expect(original.getForm().getTextField("Reviewer").acroField.getWidgets()).toHaveLength(2);
  });

  it("rejects empty and ambiguous layouts and prevents saving a restricted document", async () => {
    const source = await fixture();
    await expect(savePdfPageEdits(source, [], new Map())).rejects.toThrow("layout");
    await expect(savePdfPageEdits(source, [originalPages(1)[0], originalPages(1)[0]], new Map())).rejects.toThrow("layout");
    const restricted = await PDFDocument.load(source);
    restricted.catalog.set(PDFName.of("Perms"), restricted.context.obj({}));
    await expect(savePdfPageEdits(await restricted.save(), originalPages(3), new Map())).rejects.toThrow("does not support");
  });

  it("keeps the last page and reports the original layout after reversing a move or four rotations", () => {
    const initial = originalPages(2);
    let draft = changePageLayout(initial, 1, "later");
    expect(draft.map((page) => page.number)).toEqual([2, 1]);
    draft = changePageLayout(draft, 1, "earlier");
    for (let count = 0; count < 4; count++) draft = changePageLayout(draft, 2, "rotate");
    expect(sameLayout(draft, initial)).toBe(true);
    const single = changePageLayout(draft, 2, "remove");
    expect(changePageLayout(single, 1, "remove")).toBe(single);
  });
});
