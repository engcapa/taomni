import { convertOpenDocument } from "./legacyOffice.js";

globalThis.onmessage = async ({ data: { input, format, maxBytes } }) => {
  try {
    const result = await convertOpenDocument(new Uint8Array(input), format);
    if (result.byteLength > maxBytes) throw new Error("limits");
    const output = result.slice().buffer;
    globalThis.postMessage({ output }, [output]);
  } catch (error) {
    const limited = error.message === "limits" || error.officeIssue?.code?.endsWith("_LIMIT_EXCEEDED");
    globalThis.postMessage({ error: limited ? "limits" : "format" });
  }
};
