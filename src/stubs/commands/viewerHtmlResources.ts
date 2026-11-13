import { vfsReadBytes, parentOf } from "../localVfs";

const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_RESOURCES = 128;
const MAX_CSS_DEPTH = 8;
const resourceTypes: Record<string, string> = {
  css: "text/css", js: "application/javascript", mjs: "application/javascript",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};

function resourcePath(root: string, source: string, base: string): string | null {
  const value = source.trim();
  if (!value || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(value)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(value.split(/[?#]/)[0]); } catch { return null; }
  if (/[\\\u0000-\u001f]/.test(decoded) || decoded.startsWith("/")) return null;
  const segments = base.split("/").filter(Boolean);
  const floor = root.split("/").filter(Boolean).length;
  for (const segment of decoded.split("/")) {
    if (segment === "..") { if (segments.length <= floor) return null; segments.pop(); }
    else if (segment && segment !== ".") segments.push(segment);
  }
  const path = `/${segments.join("/")}`;
  return path.startsWith(`${root}/`) ? path : null;
}

function dataUri(bytes: Uint8Array, type: string): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}

async function replaceAsync(source: string, pattern: RegExp, replace: (match: RegExpMatchArray) => Promise<string>): Promise<string> {
  const matches = [...source.matchAll(pattern)];
  let output = "";
  let end = 0;
  for (const match of matches) {
    output += source.slice(end, match.index) + await replace(match);
    end = match.index! + match[0].length;
  }
  return output + source.slice(end);
}

/** Browser VFS only: opaque frames cannot fetch their parent's origin-bound blob
 * subresources. Embed known local resources, never grant same-origin or HTTP. */
export function createHtmlResourceLoader(root: string) {
  let total = 0;
  let count = 0;
  const cache = new Map<string, Uint8Array>();
  const generated = new Set<string>();
  const read = async (path: string): Promise<Uint8Array> => {
    const cached = cache.get(path);
    if (cached) return cached;
    if (++count > MAX_RESOURCES) throw new Error("too_large: Too many HTML resources");
    const bytes = new Uint8Array(await vfsReadBytes(path));
    total += bytes.length;
    if (bytes.length > MAX_RESOURCE_BYTES || total > MAX_TOTAL_BYTES) throw new Error("too_large: HTML resources exceed the browser preview limit");
    cache.set(path, bytes);
    return bytes;
  };
  const rewriteCss = async (source: string, base = root, ancestors = new Set<string>()): Promise<string> => {
    // Escaped CSS URLs need a full CSS parser. Fail these declarations closed
    // rather than leave a relative URL pointing at the top-level blob origin.
    if (source.includes("\\")) return "";
    const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
    const imported = await replaceAsync(css, /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'";]+))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi, async (match) => {
      const target = resourcePath(root, match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5], base);
      const media = match[6].trim();
      if (!target || resourceTypes[target.split(".").pop()?.toLowerCase() ?? ""] !== "text/css" ||
        ancestors.has(target) || ancestors.size >= MAX_CSS_DEPTH || /[{}@]/.test(media)) return "";
      try {
        const rewritten = await rewriteCss(new TextDecoder().decode(await read(target)), parentOf(target), new Set([...ancestors, target]));
        return media ? `@media ${media}{${rewritten}}` : rewritten;
      } catch { return ""; }
    });
    return replaceAsync(imported.replace(/@import[^;]*(?:;|$)/gi, ""), /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'";]+))\s*\)/gi, async (match) => {
      const href = match[1] ?? match[2] ?? match[3];
      if (/^#[\w:.-]+$/.test(href) || generated.has(href)) return `url("${href}")`;
      const resource = await asset(href, base, ancestors);
      return `url("${resource ?? "data:,"}")`;
    });
  };
  const asset = async (href: string, base = root, ancestors = new Set<string>()): Promise<string | null> => {
    const target = resourcePath(root, href, base);
    const type = target && resourceTypes[target.split(".").pop()?.toLowerCase() ?? ""];
    // Scripts are inlined separately with a nonce, never admitted via data: CSP.
    if (!target || !type || type === "application/javascript" || ancestors.has(target)) return null;
    try {
      let bytes = await read(target);
      if (type === "text/css") bytes = new TextEncoder().encode(await rewriteCss(new TextDecoder().decode(bytes), parentOf(target), new Set([...ancestors, target])));
      const uri = dataUri(bytes, type);
      generated.add(uri);
      return uri;
    } catch { return null; }
  };
  return {
    asset,
    rewriteCss,
    script: async (href: string): Promise<string | null> => {
      const target = resourcePath(root, href, root);
      if (!target || resourceTypes[target.split(".").pop()?.toLowerCase() ?? ""] !== "application/javascript") return null;
      try { return new TextDecoder().decode(await read(target)); } catch { return null; }
    },
  };
}
