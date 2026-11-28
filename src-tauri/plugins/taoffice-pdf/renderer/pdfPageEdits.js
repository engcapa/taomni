import { PDFDocument, PDFName, PDFSignature, degrees } from "@cantoo/pdf-lib";
import { appendPdfMarkup } from "./pdfMarkup.js";

const INHERITED_PAGE_KEYS = ["Resources", "MediaBox", "CropBox", "Rotate"].map(PDFName.of);

function removeDeletedWidgets(pdf, removed) {
  const acroForm = pdf.catalog.getAcroForm();
  if (!acroForm) return;
  const annotations = new Set(removed.flatMap((page) => page.node.Annots()?.asArray() ?? [])
    .map((reference) => pdf.context.lookup(reference)));
  const form = pdf.getForm();
  for (const field of form.getFields()) {
    const widgets = field.acroField.getWidgets();
    const indices = widgets.flatMap((widget, index) => annotations.has(widget.dict) ? [index] : []);
    if (indices.length && indices.length === widgets.length) {
      form.removeField(field);
    } else {
      for (const index of indices.reverse()) field.acroField.removeWidget(index);
    }
  }
}

function changePageOrder(pdf, pages, layout) {
  const retained = new Set(layout.map((item) => item.number));
  removeDeletedWidgets(pdf, pages.filter((_page, index) => !retained.has(index + 1)));
  for (const { number } of layout) {
    const leaf = pages[number - 1].node;
    for (const key of INHERITED_PAGE_KEYS) {
      const value = leaf.getInheritableAttribute(key);
      if (value) leaf.set(key, value);
    }
  }
  for (let index = pages.length - 1; index >= 0; index--) pdf.removePage(index);
  for (const { number } of layout) {
    const page = pages[number - 1];
    // removePage unregisters the leaf. Restore its original reference so links
    // and surviving widgets still point at the same page after reinsertion.
    pdf.context.assign(page.ref, page.node);
    pdf.addPage(page);
  }
}

export async function savePdfPageEdits(source, layout, markup) {
  const pdf = await PDFDocument.load(source, { updateMetadata: false, preserveXFA: true });
  const form = pdf.catalog.getAcroForm() && pdf.getForm();
  if (pdf.isEncrypted || pdf.catalog.has(PDFName.of("Perms")) || form?.hasXFA() ||
    (form && form.getFields().some((field) => field instanceof PDFSignature))) {
    throw new Error("This PDF does not support page and annotation edits.");
  }
  const pages = pdf.getPages();
  if (!layout.length || new Set(layout.map(({ number }) => number)).size !== layout.length ||
    layout.some(({ number, rotation }) => !Number.isInteger(number) || !pages[number - 1] ||
      ![0, 90, 180, 270].includes(rotation))) {
    throw new Error("The PDF page layout is invalid.");
  }
  const orderChanged = layout.length !== pages.length || layout.some(({ number }, index) => number !== index + 1);
  if (orderChanged) changePageOrder(pdf, pages, layout);

  for (const { number, rotation } of layout) {
    const page = pages[number - 1];
    if (rotation) page.setRotation(degrees((page.getRotation().angle + rotation) % 360));
    for (const annotation of markup.get(number) ?? []) appendPdfMarkup(pdf, page, annotation);
  }
  return pdf.save({ updateFieldAppearances: false, addDefaultPage: false });
}
