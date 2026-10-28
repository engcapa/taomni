// Model Tauri 2's read-only descriptors, real callback lifecycle and two IPC
// transports. No WebView is launched by these runner unit tests.
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("./qa_ui_auto/native_language_startup_observer.js", import.meta.url), "utf8");

export function harness({ protocol = "ipc://localhost/", fallback = false, readonlyFetch = false } = {}) {
  let now = 0;
  let nextId = 0;
  const requests = [];
  const callbacks = new Map();
  const window = {};
  const target = {};
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: target });
  const registerCallback = (callback, once) => {
    const id = ++nextId;
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      return callback(data);
    });
    return id;
  };
  const runCallback = (id, value) => callbacks.get(id)?.(value);
  function originalFetch(...args) {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const request = { args, receiver: this, promise, resolve, reject };
    requests.push(request);
    return promise;
  }
  Object.defineProperty(window, "fetch", { value: originalFetch, writable: !readonlyFetch });
  const send = ({ command, callback, error, payload, options }) => {
    if (fallback) {
      queueMicrotask(() => runCallback(callback, "PRIVATE_APP_NAME"));
      return;
    }
    const headers = new Headers(options?.headers);
    headers.set("Tauri-Callback", callback);
    headers.set("Tauri-Error", error);
    headers.set("Tauri-Invoke-Key", "SECRET_INVOKE_KEY");
    window.fetch(protocol + encodeURIComponent(command), { headers, body: payload }).then(
      (response) => runCallback(response.error ? error : callback, response.value),
      () => runCallback(callback, "PRIVATE_FALLBACK_RESPONSE"),
    );
  };
  function invoke(command, payload, options) {
    return new Promise((resolve, reject) => {
      const callback = registerCallback((result) => {
        resolve(result);
        callbacks.delete(error);
      }, true);
      const error = registerCallback((result) => {
        reject(result);
        callbacks.delete(callback);
      }, true);
      send({ command, callback, error, payload, options });
    });
  }
  Object.defineProperties(target, {
    invoke: { value: invoke }, callbacks: { value: callbacks }, runCallback: { value: runCallback },
  });
  const install = vm.runInNewContext(`(${source})`, {
    window, URL, Headers, performance: { now: () => ++now },
  });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const complete = async (request, value, error = false) => {
    request.resolve({ value, error });
    await flush();
  };
  return { window, target, callbacks, requests, invoke, install, flush, complete, originalFetch,
    observer: () => window.__taomniQaLanguageStartup };
}

export async function installed(options) {
  const h = harness(options);
  h.install();
  await h.complete(h.requests[0], "PRIVATE_APP_NAME");
  return h;
}
