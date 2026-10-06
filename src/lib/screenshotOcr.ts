import { createWorker } from "tesseract.js";

export interface OfflineOcrResult { text: string; tsv: string; langs: string; }

/** Per-operation workers are always terminated; no screenshot leaves the app.
 * Assets are emitted by screenshotOcrPlugin from lockfile-pinned packages. */
export async function recognizeOffline(image: string): Promise<OfflineOcrResult> {
  const base = new URL("screenshot-ocr/", document.baseURI).href;
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const task = (async () => {
    worker = await createWorker(["eng", "chi_sim"], 1, {
      workerPath: `${base}worker.min.js`, corePath: base,
      langPath: base.replace(/\/$/, ""), workerBlobURL: false,
      cacheMethod: "none", gzip: true,
    });
    if (expired) { await worker.terminate(); throw new Error("OCR timed out"); }
    const { data } = await worker.recognize(image, {}, { text: true, tsv: true });
    return { text: data.text, tsv: data.tsv ?? "", langs: "bundled:eng+chi_sim" };
  })();
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error("OCR timed out")); }, 90_000);
    })]);
  } finally {
    clearTimeout(timer);
    if (worker) await worker.terminate();
  }
}
