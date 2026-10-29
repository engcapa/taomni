(target) => {
  if (!target || typeof target.invoke !== "function") {
    throw new Error("Language startup observer: invoke boundary is unavailable");
  }
  if (window.__taomniQaLanguageStartup) {
    throw new Error("Language startup observer is already installed");
  }
  const original = target.invoke;
  const watched = new Set([
    "sdk_get_registry", "sdk_analyze_workspace", "sdk_resolve_workspace",
    "lsp_detect_servers", "lsp_discover_java_bundles", "lsp_open_document",
    "lsp_document_status", "lsp_change_document", "lsp_save_document", "lsp_close_document",
    "workspace_list_dir", "workspace_compact_chain", "workspace_list_files_recursive",
    "workspace_execution_model",
    "workspace_detect_git_roots", "git_snapshot",
    "lsp_start_workspace_watcher", "lsp_stop_workspace_watcher",
  ]);
  const events = [];
  const finish = (event, status) => {
    event.status = status;
    event.finishedMs = performance.now();
  };
  function invoke(command, args, ...rest) {
    if (!watched.has(command)) return Reflect.apply(original, this, [command, args, ...rest]);
    const event = { index: events.length, command, startedMs: performance.now(), status: "pending" };
    // Only document identities; never record source text, credentials or results.
    for (const name of ["workspaceId", "workspaceRoot", "rootPath", "filePath"]) {
      if (typeof args?.[name] === "string") event[name] = args[name];
    }
    events.push(event);
    try {
      return Promise.resolve(Reflect.apply(original, this, [command, args, ...rest])).then(
        (result) => { finish(event, "fulfilled"); return result; },
        (error) => { finish(event, "rejected"); throw error; },
      );
    } catch (error) {
      finish(event, "rejected");
      throw error;
    }
  }
  if (!Reflect.set(target, "invoke", invoke) || target.invoke !== invoke) {
    throw new Error("Language startup observer: invoke is not writable");
  }
  window.__taomniQaLanguageStartup = {
    observe: () => ({
      valid: target.invoke === invoke,
      transport: "browser-invoke",
      events: events.map((event) => ({ ...event })),
      nowMs: performance.now(),
    }),
    restore: () => {
      if (target.invoke !== invoke) throw new Error("Language startup invoke owner changed");
      if (!Reflect.set(target, "invoke", original) || target.invoke !== original) {
        throw new Error("Language startup invoke could not be restored");
      }
      delete window.__taomniQaLanguageStartup;
    },
  };
  return { installed: true, forwarding: true };
}
