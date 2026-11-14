// Runs before author scripts, in the opaque-origin sandbox. No native IPC.
(() => {
  "use strict";
  const token = __VIEWER_TOKEN__;
  const root = __VIEWER_ROOT__;
  const sendMessage = parent.postMessage.bind(parent);
  const send = (kind, fields) => sendMessage({ type: "taomni-html-preview", token, kind, ...fields }, "*");
  const stringify = value => {
    try { return typeof value === "string" ? value : JSON.stringify(value) ?? String(value); }
    catch { return "[unserializable]"; }
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      send("console", { level, message: args.map(stringify).join(" ").slice(0, 16384) });
      original(...args);
    };
  }
  addEventListener("error", event => send("console", {
    level: "error", message: String(event.message || "Resource failed to load").slice(0, 16384)
  }), true);
  addEventListener("unhandledrejection", event => send("console", {
    level: "error", message: stringify(event.reason).slice(0, 16384)
  }));
  addEventListener("securitypolicyviolation", event => send("blocked", {
    message: `Blocked ${event.effectiveDirective}`, href: String(event.blockedURI).slice(0, 4096)
  }));
  __VIEWER_NETWORK_BRIDGE__
  const navigate = href => {
    let url;
    try { url = new URL(href, location.href); }
    catch { send("blocked", { message: "Invalid link" }); return; }
    const path = url.pathname;
    let safe = false;
    try {
      safe = path.split("/").every(part => {
        const decoded = decodeURIComponent(part);
        return decoded !== ".." && !/[\\\0:]/.test(decoded) && !decoded.includes("/");
      });
    } catch { /* malformed percent escape */ }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.href.startsWith(root) && safe) {
      send("navigate", { href: url.href });
    } else if ((url.protocol === "https:" || url.protocol === "http:")
      && host !== "taomni-preview.localhost" && host !== "localhost" && !host.endsWith(".localhost")
      && !/^127\./.test(host) && host !== "[::1]" && !/^\[::ffff:7f[\da-f]{2}:/i.test(host)) {
      send("external", { href: url.href });
    } else {
      send("blocked", { message: "Link is outside the preview root", href: url.href });
    }
  };
  addEventListener("click", event => {
    const element = event.target instanceof Element ? event.target.closest("a[href],area[href]") : null;
    if (!element) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigate(element.getAttribute("href"));
  }, true);
  addEventListener("submit", event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    send("blocked", { message: "Forms are disabled in the preview" });
  }, true);
  window.open = href => { if (href != null) navigate(String(href)); return null; };
})();
