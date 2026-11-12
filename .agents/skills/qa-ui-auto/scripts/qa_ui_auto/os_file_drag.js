async (request) => {
  const observation = {
    ok: false,
    synthetic: true,
    physicalOsGesture: false,
    phase: request.phase,
    transport: request.mode === "native" ? "tauri-event-emitTo" : "html5-drag-event",
    statusMessages: [],
  };
  let observer;
  const status = () => {
    const message = document.querySelector('[data-testid="status-bar-message"]')?.textContent;
    if (message != null && observation.statusMessages.at(-1) !== message) {
      observation.statusMessages.push(message);
    }
  };
  const describe = (element) => element ? {
    tag: element.tagName,
    testId: element.getAttribute("data-testid"),
    rootId: element.getAttribute("data-root-id"),
    rootPath: element.getAttribute("data-root-path"),
    path: element.getAttribute("data-path"),
    treeKind: element.getAttribute("data-tree-kind"),
  } : null;
  try {
    let target = document;
    let point = null;
    // Native leave has exactly a null payload and needs no stale DOM target.
    if (!(request.mode === "native" && request.phase === "leave")) {
      const matches = request.selector ? document.querySelectorAll(request.selector) : [document.body];
      if (matches.length !== 1) throw new Error(`Expected one drag target, found ${matches.length}`);
      const element = matches[0];
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility !== "visible" || style.display === "none") {
        throw new Error("Drag target has no visible layout box");
      }
      const left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
      if (right <= left || bottom <= top) throw new Error("Drag target is outside the viewport");
      // Prefer an exact container hit (e.g. blank Project-tree space) over one
      // of its rows. For a row, a contained text/icon hit is equally valid.
      const candidates = [[0.5, 0.5], [0.5, 0.9], [0.1, 0.9], [0.9, 0.9], [0.5, 0.1], [0.1, 0.5], [0.9, 0.5]];
      const blankTree = element.getAttribute("data-testid") === "code-workspace-tree";
      const points = candidates.map(([fx, fy]) => ({
        x: left + (right - left) * fx, y: top + (bottom - top) * fy,
      }));
      if (blankTree) {
        // A short native window can leave only the tree's bottom padding blank.
        // Fractional samples (even 90%) still land on rows there. Probe inside
        // the actual container edges, retaining the same real hit/no-row check.
        const inset = Math.min(2, (right - left) / 2, (bottom - top) / 2);
        for (const y of [bottom - inset, top + inset]) {
          for (const x of [(left + right) / 2, left + inset, right - inset]) points.push({ x, y });
        }
      }
      const hits = points.map(({ x, y }) => ({ x, y, hit: document.elementFromPoint(x, y) }))
        .filter(({ hit }) => !blankTree || !hit?.closest("[data-tree-kind]"));
      point = hits.find(({ hit }) => hit === element)
        ?? hits.find(({ hit }) => hit && element.contains(hit));
      if (!point) throw new Error("Drag target is occluded at every candidate point");
      const scale = window.devicePixelRatio || 1;
      if (!Number.isFinite(scale) || scale <= 0) throw new Error("Invalid devicePixelRatio");
      observation.geometry = {
        selector: request.selector,
        cssPosition: { x: point.x, y: point.y },
        position: { x: point.x * scale, y: point.y * scale },
        devicePixelRatio: scale,
        target: describe(element),
        hit: describe(point.hit),
        treeRow: describe(point.hit.closest("[data-tree-kind]")),
      };
      target = point.hit;
    }
    status();
    observer = new MutationObserver(status);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    if (request.mode === "native") {
      const tauri = window.__TAURI__;
      if (!tauri?.event?.emitTo || !tauri?.webview?.getCurrentWebview) {
        throw new Error("Tauri event/webview API is unavailable");
      }
      const label = tauri.webview.getCurrentWebview().label;
      if (typeof label !== "string" || !label) throw new Error("Current Webview has no label");
      observation.eventName = `tauri://drag-${request.phase}`;
      observation.eventTarget = { kind: "Webview", label };
      observation.payload = request.phase === "leave" ? null : {
        paths: request.paths,
        position: observation.geometry.position,
      };
      await tauri.event.emitTo(observation.eventTarget, observation.eventName, observation.payload);
    } else {
      const transfer = new DataTransfer();
      transfer.setData("text/uri-list", request.uriList);
      transfer.effectAllowed = "copy";
      transfer.dropEffect = "copy";
      observation.eventName = { enter: "dragenter", over: "dragover", drop: "drop", leave: "dragleave" }[request.phase];
      const event = new DragEvent(observation.eventName, {
        bubbles: true, cancelable: true, composed: true,
        clientX: point.x, clientY: point.y, dataTransfer: transfer,
      });
      target.dispatchEvent(event);
      observation.isTrusted = event.isTrusted;
      observation.defaultPrevented = event.defaultPrevented;
      observation.payload = { paths: request.paths, uriList: request.uriList, types: [...transfer.types] };
    }
    // Observe only; do not await an import result or call a product handler.
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    status();
    observation.ok = true;
  } catch (error) {
    observation.error = String(error);
  } finally {
    observer?.disconnect();
  }
  return observation;
}
