import { expect, it } from "vitest";
import { mathFontUrl } from "./mathExportCss";

it.each(["tauri://localhost/", "http://tauri.localhost/", "https://tauri.localhost/", "http://localhost:5001/"])("resolves bundled export fonts on %s", (base) => {
  expect(mathFontUrl("/assets/math.woff2", base).href).toBe(`${base}assets/math.woff2`);
  expect(() => mathFontUrl("https://example.test/math.woff2", base)).toThrow("bundled");
});
