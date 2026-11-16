() => {
  // Forward the actual transport and callback unchanged. Do not read request
  // bodies, API keys, response bodies, or user/assistant text into this record.
  const target = window.__TAURI_INTERNALS__;
  if (!target?.callbacks || typeof target.callbacks.get !== "function" || typeof window.fetch !== "function") {
    throw new Error("Tao provider observer requires the real Tauri transport");
  }
  if (window.__taomniQaTaoProvider) throw new Error("Tao provider observer already installed");
  const originalFetch = window.fetch;
  const callbacks = target.callbacks;
  const wrapped = new Map();
  const calls = [];
  const stops = [];
  const operations = [];
  const files = [];
  const actions = [];
  const probe = { observed: false, status: "pending" };
  let failure = null;
  const fail = (value) => { failure ??= value; };
  const commandFor = (resource) => {
    try {
      const url = new URL(typeof resource === "string" ? resource : resource.url ?? resource.href);
      return ((url.protocol === "ipc:" && url.hostname === "localhost")
        || (["http:", "https:"].includes(url.protocol) && url.hostname === "ipc.localhost"))
        ? decodeURIComponent(url.pathname.slice(1)) : null;
    } catch { return null; }
  };
  function fetch(resource, options, ...rest) {
    const command = commandFor(resource);
    if (["deepseek_app_send", "deepseek_app_regenerate", "deepseek_app_continue", "deepseek_app_stop", "deepseek_app_clone_thread", "deepseek_app_upload_file", "deepseek_app_delete_file", "deepseek_app_execute_action", "deepseek_app_undo_action", "plugin:app|name"].includes(command)) {
      const event = command === "plugin:app|name" ? probe : { command, status: "pending" };
      if (event === probe) probe.observed = true;
      else if (command === "deepseek_app_stop") stops.push(event);
      else if (command === "deepseek_app_clone_thread") operations.push(event);
      else if (["deepseek_app_upload_file", "deepseek_app_delete_file"].includes(command)) files.push(event);
      else if (["deepseek_app_execute_action", "deepseek_app_undo_action"].includes(command)) actions.push(event);
      else calls.push(event);
      try {
        const headers = new Headers(options?.headers ?? resource.headers);
        for (const [name, status] of [["Tauri-Callback", "fulfilled"], ["Tauri-Error", "rejected"]]) {
          const raw = headers.get(name);
          const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN;
          const original = callbacks.get(id);
          if (!Number.isSafeInteger(id) || typeof original !== "function") { fail("callback-unavailable"); continue; }
          function callback(...args) {
            event.status = status;
            return Reflect.apply(original, this, args);
          }
          callbacks.set(id, callback);
          wrapped.set(id, { original, callback });
        }
      } catch { fail("callback-observation-failed"); }
    }
    try {
      const result = Reflect.apply(originalFetch, this, [resource, options, ...rest]);
      if (command !== null) result.then(undefined, () => fail("custom-protocol-failed"));
      return result;
    } catch (error) { if (command !== null) fail("custom-protocol-threw"); throw error; }
  }
  if (!Reflect.set(window, "fetch", fetch) || window.fetch !== fetch) throw new Error("Tao provider observer cannot observe fetch");
  window.__taomniQaTaoProvider = {
    observe: () => ({ valid: !failure && window.fetch === fetch && target.callbacks === callbacks
      && probe.observed && probe.status === "fulfilled", failure,
      calls: calls.map((call) => ({ ...call })), stops: stops.map((call) => ({ ...call })), operations: operations.map((call) => ({ ...call })),
      files: files.map((call) => ({ ...call })), actions: actions.map((call) => ({ ...call })) }),
    restore: () => {
      for (const [id, entry] of wrapped) if (callbacks.get(id) === entry.callback) callbacks.set(id, entry.original);
      if (window.fetch === fetch) Reflect.set(window, "fetch", originalFetch);
      delete window.__taomniQaTaoProvider;
    },
  };
  target.invoke("plugin:app|name").catch(() => fail("control-request-rejected"));
  return { installed: true, forwarding: true };
}
