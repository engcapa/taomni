() => {
  // Tauri 2 deliberately makes invoke/ipc/runCallback read-only. Observe its
  // real custom-protocol requests and callback Map instead; never replace IPC,
  // read a request body/invoke key, or synthesize a native response.
  const target = window.__TAURI_INTERNALS__;
  if (!target || typeof target.invoke !== "function" || !target.callbacks
      || typeof target.callbacks.get !== "function" || typeof target.callbacks.set !== "function"
      || typeof window.fetch !== "function") {
    throw new Error("Native language observer: real Tauri transport is unavailable");
  }
  if (window.__taomniQaLanguageStartup) {
    throw new Error("Language startup observer is already installed");
  }
  const originalFetch = window.fetch;
  const callbacks = target.callbacks;
  const wrappedCallbacks = new Map();
  const events = [];
  const fileReads = [];
  const fileCommands = new Set(["workspace_read_file", "workspace_read_loose_file"]);
  const probe = { command: "plugin:app|name", observed: false, status: "pending" };
  const watched = new Set([
    "sdk_get_registry", "sdk_analyze_workspace", "sdk_resolve_workspace",
    "lsp_detect_servers", "lsp_discover_java_bundles", "lsp_open_document",
    "lsp_document_status", "lsp_change_document", "lsp_save_document", "lsp_close_document",
    "workspace_list_dir", "workspace_compact_chain", "workspace_list_files_recursive",
    "lsp_start_workspace_watcher", "lsp_stop_workspace_watcher",
  ]);
  let observationError = null;
  const fail = (reason) => { observationError ??= reason; };
  function commandFor(resource) {
    try {
      const url = new URL(typeof resource === "string" ? resource : resource.url ?? resource.href);
      if (!((url.protocol === "ipc:" && url.hostname === "localhost")
          || (["http:", "https:"].includes(url.protocol) && url.hostname === "ipc.localhost"))) return null;
      return decodeURIComponent(url.pathname.slice(1));
    } catch {
      return null;
    }
  }
  function watchCallback(id, event, status) {
    if (!Number.isSafeInteger(id) || typeof callbacks.get(id) !== "function") {
      fail("real-callback-unavailable");
      return;
    }
    const original = callbacks.get(id);
    function callback(...args) {
      event.status = status;
      event.finishedMs = performance.now();
      if (event.startedEpochMs !== undefined) event.finishedEpochMs = Date.now();
      // Preserve Tauri's once/unregister and original return/throw semantics.
      return Reflect.apply(original, this, args);
    }
    callbacks.set(id, callback);
    if (callbacks.get(id) !== callback) fail("real-callback-not-writable");
    wrappedCallbacks.set(id, { original, callback });
  }
  function fetch(resource, options, ...rest) {
    const command = commandFor(resource);
    if (command !== null && (watched.has(command) || fileCommands.has(command) || command === probe.command)) {
      const output = fileCommands.has(command) ? fileReads : events;
      const event = command === probe.command ? probe : {
        index: output.length, command, startedMs: performance.now(), status: "pending",
      };
      if (event === probe) probe.observed = true;
      else {
        if (output === fileReads) event.startedEpochMs = Date.now();
        output.push(event);
      }
      try {
        const headers = new Headers(options?.headers ?? resource.headers);
        for (const [name, status] of [["Tauri-Callback", "fulfilled"], ["Tauri-Error", "rejected"]]) {
          const id = headers.get(name);
          if (id === null || !/^\d+$/.test(id)) fail("real-callback-header-unavailable");
          else watchCallback(Number(id), event, status);
        }
      } catch {
        fail("real-callback-observation-failed");
      }
    }
    try {
      const result = Reflect.apply(originalFetch, this, [resource, options, ...rest]);
      if (command !== null) {
        // A failed protocol switches Tauri to postMessage globally. Counts after
        // that fallback cannot prove absence, so invalidate evidence explicitly.
        result.then(undefined, () => fail("custom-protocol-failed"));
      }
      return result;
    } catch (error) {
      if (command !== null) fail("custom-protocol-threw");
      throw error;
    }
  }
  if (!Reflect.set(window, "fetch", fetch) || window.fetch !== fetch) {
    throw new Error("Native language observer: fetch is not writable");
  }
  window.__taomniQaLanguageStartup = {
    observe: () => ({
      valid: !observationError && window.fetch === fetch && target.callbacks === callbacks
        && probe.observed && probe.status === "fulfilled",
      transport: "tauri-fetch-callbacks",
      transportProbe: { ...probe },
      observationError,
      events: events.map((event) => ({ ...event })),
      fileReads: fileReads.map((event) => ({ ...event })),
      nowMs: performance.now(),
    }),
    restore: () => {
      if (window.fetch !== fetch || target.callbacks !== callbacks) {
        throw new Error("Native language observer transport owner changed");
      }
      for (const [id, entry] of wrappedCallbacks) {
        if (callbacks.has(id) && callbacks.get(id) !== entry.callback) {
          throw new Error("Native language observer callback owner changed");
        }
      }
      for (const [id, entry] of wrappedCallbacks) {
        if (callbacks.get(id) === entry.callback) callbacks.set(id, entry.original);
      }
      if (!Reflect.set(window, "fetch", originalFetch) || window.fetch !== originalFetch) {
        throw new Error("Native language observer fetch could not be restored");
      }
      delete window.__taomniQaLanguageStartup;
    },
  };
  try {
    target.invoke(probe.command).then(
      () => { if (!probe.observed) fail("control-request-bypassed-observer"); },
      () => fail("control-request-rejected"),
    );
  } catch {
    fail("control-request-threw");
  }
  return { installed: true, forwarding: true };
}
