import { finalizeConvertedPresentation } from "./convertedPresentation.js";
import { convertOdp } from "./legacyOdp.js";

globalThis.onmessage = async ({ data: { input, maxBytes } }) => {
  try {
    const result = await convertOdp(new Uint8Array(input));
    if (result.byteLength > maxBytes) throw new Error("limits");
    const normalized = finalizeConvertedPresentation(result, "odp");
    if (normalized.byteLength > maxBytes) throw new Error("limits");
    const output = normalized.buffer;
    globalThis.postMessage({ output }, [output]);
  } catch (error) {
    const limited = error.message === "limits" || error.officeIssue?.code?.endsWith("_LIMIT_EXCEEDED");
    globalThis.postMessage({ error: limited ? "limits" : "format" });
  }
};
