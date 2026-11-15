// Included inside the pre-author-script bridge. Security remains native+CSP;
// unrecognized dynamic constructs are blocked, never sent directly.
const allowNetwork = __VIEWER_ALLOW_NETWORK__;
const sourceBase = __VIEWER_SOURCE_BASE__ || location.href;
const encoder = new TextEncoder();
const rootOrigin = new URL(root).origin;
const mediate = value => {
  const url = new URL(String(value), sourceBase);
  if (url.href.startsWith(root) || url.protocol === "data:" || url.protocol === "blob:") return url.href;
  if (url.protocol !== "http:" && url.protocol !== "https:") return url.href;
  if (!allowNetwork) throw new TypeError("Network is disabled for this HTML preview");
  if (url.username || url.password || url.origin === rootOrigin || ["ipc.localhost", "tauri.localhost", "asset.localhost", "taomni-preview.localhost"].includes(url.hostname)) {
    throw new TypeError("Forbidden HTML resource URL");
  }
  url.hash = "";
  const encoded = btoa(String.fromCharCode(...encoder.encode(url.href))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${root}_net/${encoded}`;
};
const sourceUrl = value => value instanceof Request ? value.url : String(value);
const originalFetch = window.fetch.bind(window);
let requestCount = 0;
window.fetch = async (input, options = {}) => {
  const method = String(options.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET") throw new TypeError("HTML preview supports GET resources only");
  const href = sourceUrl(input);
  const sequence = ++requestCount;
  send("console", { level: "info", message: `Connecting resource ${sequence}: ${href}` });
  try {
    const result = await originalFetch(mediate(href), { method: "GET", credentials: "omit", signal: options.signal });
    const length = result.headers.get("Content-Length");
    send("console", { level: result.ok ? "info" : "error", message: `Resource ${sequence}: HTTP ${result.status}${length ? `, ${length} bytes` : ""}` });
    return result;
  } catch (error) {
    send("console", { level: "error", message: `Resource ${sequence} failed: ${String(error)}` });
    throw error;
  }
};
const xhrOpen = XMLHttpRequest.prototype.open;
const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.open = function (method, href, async = true, user, password) {
  if (String(method).toUpperCase() !== "GET" || !async || user || password) throw new TypeError("Only asynchronous credentialless GET is supported");
  return xhrOpen.call(this, "GET", mediate(href), true);
};
// No browser or author authorization/cookies forwarded to native transport.
XMLHttpRequest.prototype.setRequestHeader = function () { return undefined; };
const setAttribute = Element.prototype.setAttribute;
const resourceAttribute = (node, name) => ["src", "poster", "background"].includes(name)
  || (name === "href" && ["LINK", "image", "use"].includes(node.tagName));
const mediateSet = (node, name, value) => {
  if (name === "srcset") {
    if (String(value).trim().startsWith("data:")) return value;
    return String(value).split(",").map(candidate => {
      const [url, ...descriptor] = candidate.trim().split(/\s+/);
      return [mediate(url), ...descriptor].join(" ");
    }).join(", ");
  }
  return resourceAttribute(node, name) ? mediate(value) : value;
};
Element.prototype.setAttribute = function (name, value) {
  return setAttribute.call(this, name, mediateSet(this, String(name).toLowerCase(), value));
};
for (const [type, property] of [
  [HTMLImageElement, "src"], [HTMLImageElement, "srcset"], [HTMLScriptElement, "src"],
  [HTMLLinkElement, "href"], [HTMLSourceElement, "src"], [HTMLSourceElement, "srcset"],
  [HTMLMediaElement, "src"], [HTMLVideoElement, "poster"]
]) {
  const descriptor = Object.getOwnPropertyDescriptor(type.prototype, property);
  if (!descriptor?.set) continue;
  Object.defineProperty(type.prototype, property, {
    ...descriptor,
    set(value) { descriptor.set.call(this, mediateSet(this, property, value)); }
  });
}
addEventListener("load", event => {
  const target = event.target;
  if (target instanceof Element && ["IMG", "SCRIPT", "LINK", "SOURCE"].includes(target.tagName)) {
    send("console", { level: "info", message: `Completed resource: ${target.getAttribute("src") || target.getAttribute("href") || target.tagName}`.slice(0, 4096) });
  }
}, true);
