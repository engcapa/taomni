import { parseOffice } from "officeparser/slim";

export async function convertOdp(bytes) {
  const document = await parseOffice(bytes, {
    fileType: "odp",
    allowRemoteAssets: false,
    extractAttachments: true,
    decompressionLimits: {
      maxUncompressedBytes: 64 * 1024 * 1024,
      maxZipEntries: 4096,
      maxTableCells: 20_000,
      maxXmlElements: 200_000,
      maxRepeatedContent: 4 * 1024 * 1024,
    },
  });
  if (document.type !== "odp") throw new Error("format");
  if (document.warnings.some((issue) => issue.code.endsWith("_LIMIT_EXCEEDED"))) throw new Error("limits");
  const slides = document.content.filter((node) => node.type === "slide");
  if (!slides.length) throw new Error("format");
  if (slides.length > 300) throw new Error("limits");
  const { value } = await document.to("pptx");
  return value;
}
