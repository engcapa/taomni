import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

// Normalize only newly generated packages from our two pinned importers.
// Original PPTX documents keep their own themes, settings and relationships.
export function finalizeConvertedPresentation(bytes, format) {
  const parts = unzipSync(bytes);
  if (format === "odp") {
    // OfficeParser 8.9 emits an empty normalViewPr. It is optional, but
    // PowerPoint requires restoredLeft and restoredTop when it is present.
    const view = "ppt/viewProps.xml";
    if (!parts[view]) return bytes;
    const xml = strFromU8(parts[view]);
    const updated = xml.replace("<p:normalViewPr/>", "");
    if (updated === xml) return bytes;
    parts[view] = strToU8(updated);
  } else {
    // Office Oxide 0.1.17 points both slide and notes masters at theme1.
    // PowerPoint requires independent themes when there is a notes master.
    const rels = "ppt/notesMasters/_rels/notesMaster1.xml.rels";
    if (!parts[rels]) return bytes;
    const xml = strFromU8(parts[rels]);
    const updated = xml.replace('Target="../theme/theme1.xml"', 'Target="../theme/theme2.xml"');
    if (updated === xml || parts["ppt/theme/theme2.xml"]) return bytes;
    if (!parts["ppt/theme/theme1.xml"] || !parts["[Content_Types].xml"]) throw new Error("format");
    parts["ppt/theme/theme2.xml"] = parts["ppt/theme/theme1.xml"];
    parts[rels] = strToU8(updated);
    const type = '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>';
    const types = strFromU8(parts["[Content_Types].xml"]);
    parts["[Content_Types].xml"] = strToU8(types.replace("</Types>", type + "</Types>"));
  }
  return zipSync(parts, { level: 6 });
}
