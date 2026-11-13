import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHtmlResourceLoader } from "./viewerHtmlResources";

const files = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("../localVfs", () => ({
  parentOf: (path: string) => path.slice(0, path.lastIndexOf("/")),
  vfsReadBytes: vi.fn(async (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error("Not found");
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }),
}));
const put = (path: string, source: string) => files.set(path, new TextEncoder().encode(source));
function decoded(uri: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(uri.slice(uri.indexOf(",") + 1)), (character) => character.charCodeAt(0)));
}
beforeEach(() => files.clear());

describe("opaque browser HTML VFS resources", () => {
  it("embeds CSS/images as data rather than origin-bound subresource blobs", async () => {
    put("/docs/assets/app.css", "#local-resource {color:rgb(12, 34, 56)}");
    files.set("/docs/assets/pixel.png", new Uint8Array([137, 80, 78, 71]));
    const loader = createHtmlResourceLoader("/docs");
    const css = await loader.asset("assets/app.css");
    const image = await loader.asset("assets/pixel.png");
    expect(css).toMatch(/^data:text\/css;base64,/);
    expect(decoded(css!)).toContain("rgb(12, 34, 56)");
    expect(image).toBe("data:image/png;base64,iVBORw==");
    expect(css).not.toContain("blob:");
    expect(image).not.toContain("blob:");
  });

  it("recursively resolves stylesheet imports, child-relative images and fonts without losing embedded child assets", async () => {
    put("/docs/assets/app.css", '@import "styles/theme.css" screen; main{background:url("images/bg.png")}');
    put("/docs/assets/styles/theme.css", '@import "second.css"; @font-face{font-family:qa;src:url("../fonts/font.woff2")}');
    put("/docs/assets/styles/second.css", '.child{color:rgb(12,34,56);background:url("../images/bg.png")}');
    files.set("/docs/assets/images/bg.png", new Uint8Array([137, 80, 78, 71]));
    files.set("/docs/assets/fonts/font.woff2", new Uint8Array([119, 79, 70, 50]));
    const css = decoded((await createHtmlResourceLoader("/docs").asset("assets/app.css"))!);
    expect(css).toContain("@media screen{");
    expect(css).toContain("rgb(12,34,56)");
    expect(css).toContain('url("data:font/woff2;base64,d09GMg==")');
    expect(css.match(/data:image\/png;base64,iVBORw==/g)).toHaveLength(2);
    expect(css).not.toContain("@import");
    expect(css).not.toContain("blob:");
  });

  it("breaks CSS import cycles and blocks remote/unknown/out-of-root resources", async () => {
    put("/docs/assets/app.css", '@import "app.css"; @import "https://tracker.invalid/theme.css"; body{color:red;background:url(https://tracker.invalid/pixel)}');
    put("/secret.css", "body{color:blue}");
    const loader = createHtmlResourceLoader("/docs");
    const css = decoded((await loader.asset("assets/app.css"))!);
    expect(css).toContain("color:red");
    expect(css).toContain('url("data:,")');
    expect(css).not.toMatch(/tracker|@import/);
    for (const path of ["../secret.css", "assets/../../secret.css", "https://tracker.invalid/pixel", "data:text/css,bad", "blob:http://localhost/parent", "file:///secret.css", "assets/unknown.bin"]) {
      expect(await loader.asset(path)).toBeNull();
    }
  });

  it("keeps local gradient references, rewrites inline CSS resources and refuses escaped URLs", async () => {
    files.set("/docs/pixel.png", new Uint8Array([1, 2]));
    const loader = createHtmlResourceLoader("/docs");
    expect(await loader.rewriteCss("fill:url(#gradient);background:url(pixel.png)")).toBe('fill:url("#gradient");background:url("data:image/png;base64,AQI=")');
    expect(await loader.rewriteCss(String.raw`background:u\72l(https://tracker.invalid)`)).toBe("");
  });

  it("returns only known local JavaScript text for nonce-inline insertion and bounds allocation", async () => {
    put("/docs/assets/app.js", 'console.log("LOCAL_JS_OK");');
    files.set("/docs/huge.png", new Uint8Array(8 * 1024 * 1024 + 1));
    const loader = createHtmlResourceLoader("/docs");
    expect(await loader.script("assets/app.js")).toContain("LOCAL_JS_OK");
    expect(await loader.asset("assets/app.js")).toBeNull();
    expect(await loader.script("https://tracker.invalid/app.js")).toBeNull();
    expect(await loader.asset("huge.png")).toBeNull();
  });
});
