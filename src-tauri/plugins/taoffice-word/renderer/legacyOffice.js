import { parseOffice } from "officeparser/slim";

const limits = {
  maxUncompressedBytes: 32 * 1024 * 1024,
  maxZipEntries: 1024,
  maxTableCells: 20_000,
  maxXmlElements: 200_000,
  maxRepeatedContent: 4 * 1024 * 1024,
};

export async function convertOpenDocument(bytes, format) {
  if (format === "rtf" && !/^\s*\{\\rtf[0-9]/u.test(new TextDecoder().decode(bytes.subarray(0, 32)))) {
    throw new Error("format");
  }
  const document = await parseOffice(bytes, {
    fileType: format,
    allowRemoteAssets: false,
    extractAttachments: true,
    includeBreakNodes: true,
    decompressionLimits: limits,
  });
  if (document.warnings.some((warning) => warning.code.endsWith("_LIMIT_EXCEEDED"))) {
    throw new Error("limits");
  }
  const { value } = await document.to("docx", { includeCharts: false });
  return value;
}
