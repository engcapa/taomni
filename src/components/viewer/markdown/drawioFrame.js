/* global Graph, mxCodec, mxUtils */
const engine = document.currentScript.dataset.engine;
const parentWindow = window.parent;
for (const name of ["PROXY_URL", "STYLE_PATH", "SHAPES_PATH", "STENCIL_PATH", "DRAW_MATH_URL", "GRAPH_IMAGE_PATH", "mxImageBasePath", "mxBasePath"]) {
  window[name] = "about:blank";
}
window.mxLoadResources = false;
window.mxLoadStylesheets = false;

function post(message) {
  parentWindow.postMessage(message, "*");
}

const script = document.createElement("script");
script.src = engine;
script.onerror = () => post({ type: "drawio-error", error: "Unable to load the bundled draw.io renderer" });
script.onload = () => {
  window.addEventListener("message", async ({ source, data }) => {
    if (source !== parentWindow || data?.type !== "drawio-render" || typeof data.xml !== "string") return;
    const host = document.createElement("div");
    host.style.cssText = "width:2000px;height:1200px;position:absolute;overflow:hidden";
    document.body.append(host);
    let graph;
    try {
      await document.fonts.load('400 12px "Architects Daughter"').catch(() => []);
      const model = mxUtils.parseXml(data.xml);
      graph = new Graph(host);
      graph.setEnabled(false);
      graph.setHtmlLabels(data.rich);
      graph.enableFlowAnimation = false;
      new mxCodec(model).decode(model.documentElement, graph.getModel());
      const bounds = graph.getGraphBounds();
      if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width > 100000 || bounds.height > 100000) {
        throw new Error("draw.io sheet is too large to preview");
      }
      const background = model.documentElement.getAttribute("background");
      const svg = graph.getSvg(background && background !== "none" ? background : null, 1, 12,
        false, null, true, null, null, null, null, null, "light", null, null, null, true);
      if (model.documentElement.getAttribute("shadow") === "1") graph.addSvgShadow(svg);
      post({ type: "drawio-result", id: data.id, svg: new XMLSerializer().serializeToString(svg) });
    } catch (error) {
      post({ type: "drawio-result", id: data.id, error: String(error) });
    } finally {
      graph?.destroy();
      host.remove();
    }
  });
  post({ type: "drawio-ready" });
};
document.head.append(script);
