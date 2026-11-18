import engineAsset from "./vendor/viewer-static.min.js?url";
import fontAsset from "./vendor/architects-daughter.ttf?inline";
import bridgeAsset from "./drawioFrame.js?url&no-inline";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../../../lib/runtime";

const TIMEOUT = 20_000;
let loading: Promise<HTMLIFrameElement> | undefined;
let renderId = 0;

function frameDocument(): string {
  const engine = new URL(engineAsset, location.href);
  const bridge = new URL(bridgeAsset, location.href);
  const html = document.implementation.createHTMLDocument("");
  const policy = html.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  const scripts = [bridge, engine].map((url) => url.href.split(/[?#]/)[0]).join(" ");
  policy.content = `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; img-src data:; font-src data:;`;
  const fontStyle = html.createElement("style");
  fontStyle.textContent = `@font-face{font-family:"Architects Daughter";src:url("${fontAsset}") format("truetype")}`;
  const script = html.createElement("script");
  script.src = bridge.href;
  script.dataset.engine = engine.href;
  html.head.append(policy, fontStyle);
  html.body.append(script);
  return "<!doctype html>" + html.documentElement.outerHTML;
}

async function createFrame(): Promise<HTMLIFrameElement> {
  // WKWebView can reject tauri: subresources from an opaque srcdoc. The
  // desktop host returns a fixed loopback document in that environment.
  const nativeUrl = isTauriRuntime() ? await invoke<string | null>("viewer_drawio_renderer_url") : null;
  if (nativeUrl) {
    const url = new URL(nativeUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username || url.password || url.search || url.hash ||
        !/^\/_drawio-renderer\/[a-f0-9]{32}\/index\.html$/.test(url.pathname)) {
      throw new Error("Invalid bundled draw.io renderer URL");
    }
  }
  return new Promise<HTMLIFrameElement>((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("data-drawio-renderer", "");
    frame.tabIndex = -1;
    frame.referrerPolicy = "no-referrer";
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:2048px;height:1280px;pointer-events:none;border:0";
    const finish = (error?: string) => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      if (error) { frame.remove(); reject(new Error(error)); }
      else resolve(frame);
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      if (event.data?.type === "drawio-ready") finish();
      if (event.data?.type === "drawio-error") finish(event.data.error);
    };
    const timer = window.setTimeout(() => finish("The bundled draw.io renderer did not start"), TIMEOUT);
    window.addEventListener("message", receive);
    if (nativeUrl) frame.src = nativeUrl;
    else frame.srcdoc = frameDocument();
    document.body.append(frame);
  });
}

function loadFrame(): Promise<HTMLIFrameElement> {
  loading ??= createFrame().catch((error: unknown) => { loading = undefined; throw error; });
  return loading;
}

export async function renderInDrawioFrame(model: Element, rich: boolean): Promise<string> {
  const frame = await loadFrame();
  const id = ++renderId;
  return new Promise<string>((resolve, reject) => {
    const finish = (error: string | undefined, svg?: string) => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      if (svg) resolve(svg);
      else reject(new Error(error || "draw.io did not return an SVG"));
    };
    const receive = (event: MessageEvent) => {
      if (event.source === frame.contentWindow && event.data?.type === "drawio-result" && event.data.id === id) {
        finish(typeof event.data.error === "string" ? event.data.error : undefined,
          typeof event.data.svg === "string" ? event.data.svg : undefined);
      }
    };
    const timer = window.setTimeout(() => finish("draw.io rendering timed out"), TIMEOUT);
    window.addEventListener("message", receive);
    frame.contentWindow?.postMessage({ type: "drawio-render", id, rich, xml: new XMLSerializer().serializeToString(model) }, "*");
  });
}
