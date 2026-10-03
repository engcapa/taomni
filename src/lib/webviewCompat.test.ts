import { afterEach, describe, expect, it } from "vitest";
import { installWebviewCompat } from "./webviewCompat";

type UrlConstructorWithCanParse = typeof URL & {
  canParse?: (url: string, base?: string) => boolean;
};

type RegExpConstructorWithEscape = RegExpConstructor & {
  escape?: (value: string) => string;
};

const URLCtor = URL as UrlConstructorWithCanParse;
const RegExpCtor = RegExp as RegExpConstructorWithEscape;
const originalCanParse = URLCtor.canParse;
const originalEscape = RegExpCtor.escape;

afterEach(() => {
  if (originalCanParse) {
    URLCtor.canParse = originalCanParse;
  } else {
    Reflect.deleteProperty(URLCtor, "canParse");
  }

  if (originalEscape) {
    RegExpCtor.escape = originalEscape;
  } else {
    Reflect.deleteProperty(RegExpCtor, "escape");
  }
});

describe("installWebviewCompat", () => {
  it("polyfills URL.canParse when the WebView does not provide it", () => {
    Reflect.deleteProperty(URLCtor, "canParse");

    installWebviewCompat();

    expect(URL.canParse("https://taomni.example")).toBe(true);
    expect(URL.canParse("/relative-only")).toBe(false);
    expect(URL.canParse("/relative", "https://taomni.example")).toBe(true);
    expect(URL.canParse("http://[")).toBe(false);
  });

  it("keeps an existing URL.canParse implementation", () => {
    const existing = () => true;
    URLCtor.canParse = existing;

    installWebviewCompat();

    expect(URLCtor.canParse).toBe(existing);
  });

  it("polyfills RegExp.escape when the WebView does not provide it", () => {
    Reflect.deleteProperty(RegExpCtor, "escape");

    installWebviewCompat();

    expect(RegExpCtor.escape?.("a+b[c]")).toBe("a\\+b\\[c\\]");
  });
});
