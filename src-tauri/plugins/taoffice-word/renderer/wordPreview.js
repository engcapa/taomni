import { parseAsync, renderDocument } from "docx-preview";

const options = {
  className: "taoffice-word-page",
  ignoreFonts: true,
  renderAltChunks: false,
  useBase64URL: true,
};

export async function renderWordPreview(bytes) {
  const file = await parseAsync(bytes, options);
  const nodes = await renderDocument(file, options);
  const content = document.createElement("div");
  content.append(...nodes);
  for (const anchor of content.querySelectorAll("a[href]")) {
    if (!anchor.getAttribute("href").startsWith("#")) anchor.removeAttribute("href");
  }
  const policy = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'
    + policy + '"></head><body style="margin:0">' + content.innerHTML + "</body></html>";
}
