type UrlConstructorWithCanParse = typeof URL & {
  canParse?: (url: string, base?: string) => boolean;
};

type RegExpConstructorWithEscape = RegExpConstructor & {
  escape?: (value: string) => string;
};

export function installWebviewCompat(): void {
  installUrlCanParse();
  installRegExpEscape();
}

function installUrlCanParse(): void {
  if (typeof globalThis.URL !== "function") return;

  const URLCtor = globalThis.URL as UrlConstructorWithCanParse;
  if (typeof URLCtor.canParse === "function") return;

  URLCtor.canParse = (url: string, base?: string): boolean => {
    try {
      if (base === undefined) {
        new URL(url);
      } else {
        new URL(url, base);
      }
      return true;
    } catch {
      return false;
    }
  };
}

function installRegExpEscape(): void {
  if (typeof globalThis.RegExp !== "function") return;

  const RegExpCtor = globalThis.RegExp as RegExpConstructorWithEscape;
  if (typeof RegExpCtor.escape === "function") return;

  RegExpCtor.escape = (value: string): string => (
    String(value).replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")
  );
}

installWebviewCompat();
