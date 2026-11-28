import { PPTXViewer } from "pptxviewjs";

let viewer;
let canvas;
let port;
let working = false;

function pngFromCanvas(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not render the slide.")), "image/png");
  });
}

async function render({ bytes, index, width, height }) {
  if (bytes) {
    viewer?.destroy();
    viewer = new PPTXViewer({
      enableThumbnails: false,
      autoExposeGlobals: true,
      autoChartRerenderDelayMs: 0,
      autoRenderFirstSlide: false,
    });
    canvas = document.createElement("canvas");
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    await viewer.loadFile(bytes);
    viewer.setCanvas(canvas);
  }
  await viewer.renderSlide(index, canvas);
  return pngFromCanvas(canvas);
}

function connect(event) {
  if (event.source !== window.parent || event.data !== "taoffice-ppt-renderer" || event.ports.length !== 1) return;
  window.removeEventListener("message", connect);
  [port] = event.ports;
  port.onmessage = async ({ data }) => {
    if (working) return;
    working = true;
    try {
      const image = await render(data);
      port.postMessage({ id: data.id, image });
    } catch {
      port.postMessage({ id: data.id, failed: true });
    } finally {
      working = false;
    }
  };
  port.postMessage({ ready: true });
}

window.addEventListener("message", connect);
window.addEventListener("pagehide", () => {
  port?.close();
  viewer?.destroy();
}, { once: true });
