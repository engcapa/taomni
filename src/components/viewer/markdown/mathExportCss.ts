import katexCss from "katex/dist/katex.min.css?inline";

let embedded: Promise<string> | undefined;
export function mathFontUrl(path: string, baseUri: string): URL {
  const base = new URL(baseUri), url = new URL(path, base);
  // Custom Tauri schemes have an opaque URL.origin in some WebViews.
  if (url.protocol !== "data:" && (url.protocol !== base.protocol || url.host !== base.host)) throw new Error("Export fonts must be bundled with the application");
  return url;
}
async function embedFonts(): Promise<string> {
  const faces = katexCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  const fonts = await Promise.all(faces.map(async (face) => {
    const source = /url\((?:"([^"]+)"|'([^']+)'|([^)]*))\)\s*format\(["']woff2["']\)/.exec(face);
    if (!source) throw new Error("The bundled math font is unavailable");
    const path = source[1] || source[2] || source[3];
    const url = mathFontUrl(path, document.baseURI);
    // Vite already embeds smaller fonts. Packaged WebKit can disallow fetching
    // data URLs even though its CSS font loader accepts the embedded bytes.
    if (url.protocol === "data:") {
      return face.replace(/src:[^}]+/, `src:url("${url.href}") format("woff2")`);
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error("Cannot read the bundled math font");
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject;
      void response.blob().then((blob) => reader.readAsDataURL(blob), reject);
    });
    return face.replace(/src:[^}]+/, `src:url("${data}") format("woff2")`);
  }));
  return fonts.join("") + katexCss.replace(/@font-face\s*\{[^}]*\}/g, "");
}

/** Standalone HTML and isolated page renderers need both math layout CSS and
 * local font bytes. They cannot inherit the application's document styles. */
export function mathExportCss(root: HTMLElement): Promise<string> {
  if (!root.querySelector(".katex")) return Promise.resolve("");
  embedded ??= embedFonts().catch((error) => { embedded = undefined; throw error; });
  return embedded;
}
