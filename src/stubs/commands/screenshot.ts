import { createScreenshotFavoritesFault } from "../screenshotFavoritesFault";

// Screenshot tool stub helpers (browser preview only).
export const STUB_SCREENSHOT_DATA_URL: string = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAAEsCAIAAABi1XKVAAAHYElEQVR42u3UsQ3DIBRAQSZJ7do1QzAEQ3gSaoZgCMZJnSodcvlFE8m5pzfDpbfC5XT6/jyOva9UvR6pOXjCELCABSxgAQtYwAIWsIAFLGABS8ACFrCABSxgAQtYwAIWsIAFLAELWMACFrCABSxgAQtYwAIWsAQsYAELWMACFqeABSxgAQtYwBKwgAUsYAELWAYWsIAFLGABC1gGFrCABSxgAcvAAhawgAUsYBlYwAIWsIAFLAMLWMACFrCABSxgAQtYwAIWsAwsYAELWMACFrCABSxgAQtYwDKwgAUsYAELWMACFrCABSxgAQtYAhawgAUsYAELWMACFrCABSxgCVjAAhawgAUsYAELWMACFrCAJWABC1jAAhawgAUsYAELWMACloAFLGABC1jAMrCABSxgAQtYAhawgAUsYAHLGAIWsIAFLGABy8ACFrCABSxgGVjAAhawgAUsAwtYwAIWsIBlYAELWMACFrCABSxgAQtYwAKWgQUsYAELWMACFrCABSxgAQtYBhawgAUsYAELWMACFrCABSxgAUvAAhawgAUsYAELWMACFrCABSwBC1jAAhawgAUsYAELWMACFrAELGABC1jAAhawgAUsYAELWMASsIAFLGABC1gGFrCABSxgAUvAAhawgAUsYAGLRMACFrCABSxgGVjA+h1YikcoYAELWMACFrAMLGABC1jAApaBBSxgAQtYwDKwgAUsYAELWMACFrCABSxgAcvAAhawgAUsYAELWMACFrCABSwDC1jAAhawgAUsYAELWMACFrAMLGABC1jAAhawgAUsYAELWMACloAFLGABC1jAAhawgAUsYAELWAIWsIAFLGABC1jAAhawgAUsYAlYwAIWsIAFLEgBaxescjp4LtX398EqzetRpoMDC1jAAhawgAUsYAELWMACFrCAZWABC1jAAhawgAUsYAELWMACloEFLGABC1jAAhawgAUsYAELWAYWsIAFLGABi1PAAhawgAUsYBlYwAIWsIAFLAMLWMACFrCABSxIAQtYwAIWsIBlYAELWMACFrAMLGABC1jAApaBBSxgAQtYwAIWsIAFLGABC1gGFrCABSxgAQtYwAIWsIAFLGAZWMACFrCABSxgAQtYwAIWsIAFLAwBC1jAAhawgAUsYAELWMACFrAMLGABC1jAAhawgAUsYAELWMAysIAFLGABC1jAAhawgAUsYAHLwAIWsIAFLGBxCljAAhawgAUsAwtYwAIWsIBlYAELWMACFrCAZWABC1jAAhawDCxgAQtYwAKWgQUsYAELWMAysIAFLGABC1jAAhawgAUsYAHLwAIWsIAFLGABC1jAAhawgAUsAwtYwAIWsIAFLGABC1jAAhawgEUiYAELWMACFrCABSxgAQtYwAKWgQUsYAELWMACFrCABSxgAQtYBhawgAUsYAELWMACFrCABSxgGVjAAhawgAUsAwtYwAIWsIBlYAELWMACFrCMIWABC1jAAhawDCxgAQtYwAKWgQUsYAELWMAysIAFLGABC1gGFrCABSxgAQtYwAIWsIAFLGAZWMACFrCABSxgAQtYwAIWsIBlYAELWMACFrCABSxgAQtYwAIWsEgELGABC1jAAhawgAUsYAELWMAysIAFLGABC1jAAhawgAUsYAHLwAIWsIAFLGABC1jAAhawgAUsAwtYwAIWsIBlYAELWMAC1qPB6tXBc2++vw9Wn16P/nFwYAELWMACFrCABSxgAQtYwAIWsAwsYAELWMACFrCABSxgAQtYwDKwgAUsYAELWMACFrCABSxgAcvAAhawgAUsYHEKWMACFrCABSwDC1jAAhawgGVgAQtYwAIWsIAFKWABC1jAAhawDCxgAQtYwAKWgQUsYAELWMAysIAFLGABC1jAAhawgAUsYAHLwAIWsIAFLGABC1jAAhawgPUHYL0UC1jAAhawgAUsYAELWMACFrCABSwDC1jAAhawgAUsYAELWMACFrAMLGABC1jAAhawgAUsYAELWMAysIAFLGABC1icAhawgAUsYAHLwAIWsIAFLGAZWMACFrCABSxgQQpYwAIWsIAFLAELWMACFrCAZWABC1jAAhawBCxgAQtYwAIWsIAFLGABC1jAErCABSxgAQtYwAIWsIAFLGABS8ACFrCABSxgAQtYwAIWsIAFLGBhCFjAAhawgAUsYAELWMACFrCAZWABC1jAAhawgAUsYAELWMACloEFLGABC1jAAhawgAUsYAELWAYWsIAFLGABi1PAAhawgAUsYBlYwAIWsIAFLAMLWMACFrCABSwDC1jAAhawgCVgAQtYwAIWsAwsYAELWMACloAFLGABC1jAAhawgAUsYAELWAIWsIAFLGABC1jAAhawgAUsYAlYwAIWsIAFLGABC1jAAhawgAUsEgELWMACFrCABSxgAQtYwAIWsAwsYAELWMACFrCABSxgAQtYwDKwgAUsYAELWMACFrCABSxgAcvAAhawgAUsYBlYwAIWsIAFLAMLWMACFrCAZWABC1jAAtYD+wK40T0UTMEo5gAAAABJRU5ErkJggg==";

/** Browser-preview screenshot artifacts: stub path -> data URL. */
export const stubScreenshotFiles = new Map<string, string>();

export let stubScreenshotIncludeWindow = false;

export let stubScreenshotScrollAttempts = 0;

export const stubScreenshotFavoritesFails = createScreenshotFavoritesFault();

export let stubScreenshotActivePin: { path: string; width: number; height: number; favoriteId: string | null; note?: string } | null = null;

export let stubScreenshotDocument = false;

export let stubPinToolsView = { zoom: 1, opacity: 1, note: "", busy: false, error: null as string | null, notice: null as string | null };

/** Browser preview has one route; simulate only the absent parent window. */
export async function stubPinToolAction(request: { action: string; value?: any }): Promise<void> {
  const { action, value } = request;
  if (action === "zoom") stubPinToolsView.zoom = Math.max(0.1, Math.min(4, Number(value)));
  if (action === "opacity") stubPinToolsView.opacity = Math.max(0.1, Math.min(1, Number(value)));
  if (action === "note") stubPinToolsView.note = await invokeScreenshot<string>("screenshot_set_pin_note", { note: value });
  if (action === "edit") await invokeScreenshot("screenshot_edit_pin");
  if (action === "external") await invokeScreenshot("screenshot_open_editor", { path: stubScreenshotActivePin?.path });
  if (action === "arrange") await invokeScreenshot("screenshot_arrange_pins", { mode: value });
  if (action === "batch") await invokeScreenshot("screenshot_pins_batch", { action: value });
  if (action === "focus") await invokeScreenshot("screenshot_focus_pin", { label: value });
  const { emit } = await import("../tauri-event");
  await emit("screenshot://pin-view", { ...stubPinToolsView });
}

export let stubPinSequence = 0;

export const stubPins = new Map<string, { path: string; width: number; height: number; note: string; order: number }>();

export let stubActivePinLabel = "screenshot-pin-1";

export type StubScreenshotFavorite = { id: string; width: number; height: number; createdAt: number; dataUrl: string; note?: string };

export const STUB_SCREENSHOT_FAVORITES = "taomni.stub.screenshotFavorites.v1";

export function screenshotFavorites(): StubScreenshotFavorite[] {
  return JSON.parse(localStorage.getItem(STUB_SCREENSHOT_FAVORITES) ?? "[]") as StubScreenshotFavorite[];
}

export async function screenshotImageSize(path: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("Screenshot image unavailable"));
    image.src = path;
  });
}

export function stubScreenshotCall(cmd: string, args: unknown): void {
  try {
    const w = window as unknown as Record<string, unknown>;
    const log = (w.__taomniStubScreenshotCalls as Array<{ cmd: string; args: unknown }>) ?? [];
    log.push({ cmd, args });
    w.__taomniStubScreenshotCalls = log;
  } catch {
    /* ignore */
  }
}

export async function invokeScreenshot<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    // ---------- Screenshot tool (browser preview) ----------
    // Synthetic 400x300 desktop; the overlay treats it like a captured screen.
    // `screenshot_open_overlay` navigates the page to the overlay hash so the
    // browser flow is end-to-end testable. Calls are logged to
    // `window.__taomniStubScreenshotCalls` for `eval_readonly` assertions;
    // exported images are decoded so cases can assert their real size.
    case "screenshot_list_displays": {
      return ([
        { id: "0,0", name: "Stub Display", width: 400, height: 300, x: 0, y: 0, scaleFactor: 1, primary: true },
        { id: "-400,0", name: "Second Display", width: 400, height: 300, x: -400, y: 0, scaleFactor: 1, primary: false },
      ] as unknown) as T;
    }

    case "screenshot_switch_display": {
      stubScreenshotCall(cmd, args);
      return { path: STUB_SCREENSHOT_DATA_URL, displayId: args?.displayId, width: 400, height: 300, scaleFactor: 1 } as T;
    }

    case "screenshot_overlay_init": {
      if (stubScreenshotDocument && stubScreenshotActivePin) return { ...stubScreenshotActivePin, displayId: "0,0", scaleFactor: 1, document: true, sourcePin: stubActivePinLabel } as T;
      return ({
        windowRegion: stubScreenshotIncludeWindow ? { x: 40, y: 30, width: 320, height: 240 } : null,
        path: STUB_SCREENSHOT_DATA_URL,
        displayId: "0,0",
        width: 400,
        height: 300,
        scaleFactor: 1,
      } as unknown) as T;
    }

    case "screenshot_open_overlay": {
      stubScreenshotDocument = false;
      stubScreenshotIncludeWindow = Boolean(args?.includeCurrentWindow);
      stubScreenshotCall(cmd, args);
      location.hash = "screenshot-overlay";
      return (undefined as unknown) as T;
    }

    case "screenshot_close_overlay": {
      stubScreenshotCall(cmd, args);
      // A pin is a separate native window; keep its browser route alive
      // when the originating overlay session closes.
      if (location.hash !== "#screenshot-pin") location.hash = stubScreenshotDocument ? "screenshot-pin" : "";
      return (undefined as unknown) as T;
    }

    case "screenshot_capture_full": {
      return ({ path: STUB_SCREENSHOT_DATA_URL, width: 400, height: 300 } as unknown) as T;
    }

    case "screenshot_capture_region": {
      const a = (args ?? {}) as { width?: number; height?: number };
      return ({
        path: STUB_SCREENSHOT_DATA_URL,
        width: Number(a.width ?? 400),
        height: Number(a.height ?? 300),
      } as unknown) as T;
    }

    case "screenshot_scroll_surface": return false as T;

    case "screenshot_scroll_plan": {
      stubScreenshotCall(cmd, args);
      const r = args as { x: number; y: number; width: number; height: number };
      return { x: r.x, y: r.y, width: r.width, height: r.height } as T;
    }

    case "screenshot_scroll_status": {
      return ({ frames: 3, mode: new URLSearchParams(location.search).get("qaScrollMode") === "manual" ? "manual" : "auto", needsOverlap: false } as unknown) as T;
    }

    case "screenshot_set_scroll_mode": {
      stubScreenshotCall(cmd, args);
      return undefined as T;
    }

    case "screenshot_stop_scroll_capture": {
      stubScreenshotCall(cmd, args);
      location.hash = "screenshot-overlay";
      return undefined as T;
    }

    case "screenshot_recording_status": {
      return ({ recordingId: "stub-rec-1", finished: false, stoppedByUser: false,
        region: { x: 40, y: 30, width: 320, height: 240 } } as unknown) as T;
    }

    case "screenshot_scroll_capture": {
      stubScreenshotCall(cmd, args);
      // Browser-only deterministic fault fixture; native denial is tested at its own boundary.
      const fault = new URLSearchParams(location.search).get("qaScreenshotScrollError");
      if (fault === "always" || (fault === "once" && stubScreenshotScrollAttempts++ === 0)) {
        throw new Error("Scrolling capture requires macOS Accessibility permission. Press Esc to leave the screenshot overlay, then open System Settings > Privacy & Security > Accessibility and enable Taomni. If launched from Terminal, enable Terminal instead (or the terminal app named by macOS); use + to add /System/Applications/Utilities/Terminal.app if it is missing. Restart the launching app after granting permission, then retry.");
      }
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 1800;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#f5f5f5";
      ctx.fillRect(0, 0, 400, 1800);
      ctx.font = "20px sans-serif";
      for (let y = 40; y < 1800; y += 60) {
        ctx.fillStyle = "#222";
        ctx.fillText(`Scroll preview row ${y / 60}`, 20, y);
        ctx.strokeRect(10, y - 30, 380, 45);
      }
      return ({
        path: canvas.toDataURL("image/png"),
        width: 400,
        height: 1800,
        frames: 3,
      } as unknown) as T;
    }

    case "screenshot_overlay_update": {
      stubScreenshotCall(cmd, args);
      return (undefined as unknown) as T;
    }

    case "screenshot_save_data_url": {
      const dataUrl = String((args as { dataUrl?: string } | undefined)?.dataUrl ?? "");
      const size = await new Promise<{ width: number; height: number }>((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve({ width: 0, height: 0 });
        image.src = dataUrl;
      });
      const path = `stub-annotated-${Date.now()}.png`;
      stubScreenshotFiles.set(path, dataUrl);
      stubScreenshotCall(cmd, { path, ...size });
      return ({ path, ...size } as unknown) as T;
    }

    case "screenshot_read_file": {
      throw new Error("screenshot_read_file is native-only");
    }

    case "screenshot_copy_image":

    case "screenshot_set_pin_compact":

    case "screenshot_save_image": {
      stubScreenshotCall(cmd, args);
      return (undefined as unknown) as T;
    }

    case "screenshot_close_pin": {
      stubScreenshotCall(cmd, args);
      stubPins.delete(String(args?.label ?? stubActivePinLabel));
      if (location.hash !== "#screenshot-pin-board") location.hash = "";
      return (undefined as unknown) as T;
    }

    case "screenshot_pin_to_screen": {
      stubScreenshotCall(cmd, args);
      const path = String((args as { path: string }).path);
      const dataUrl = stubScreenshotFiles.get(path) ?? (path.startsWith("data:") ? path : STUB_SCREENSHOT_DATA_URL);
      stubScreenshotActivePin = { path: dataUrl, ...await screenshotImageSize(dataUrl), favoriteId: null, note: "" };
      stubActivePinLabel = `screenshot-pin-${++stubPinSequence}`;
      stubPins.set(stubActivePinLabel, { ...stubScreenshotActivePin, note: "", order: stubPinSequence });
      location.hash = "screenshot-pin";
      return stubActivePinLabel as T;
    }

    case "screenshot_pin_init": {
      const files = [...stubScreenshotFiles.values()];
      return (stubScreenshotActivePin ?? { path: files[files.length - 1] ?? STUB_SCREENSHOT_DATA_URL, width: 400, height: 300, favoriteId: null }) as T;
    }

    case "screenshot_update_pin": {
      stubScreenshotCall(cmd, args);
      const dataUrl = stubScreenshotFiles.get(String(args?.path)) ?? STUB_SCREENSHOT_DATA_URL;
      const pin = stubPins.get(stubActivePinLabel);
      stubScreenshotActivePin = { path: dataUrl, ...await screenshotImageSize(dataUrl), note: pin?.note ?? "", favoriteId: null };
      if (pin) stubPins.set(stubActivePinLabel, { ...pin, ...stubScreenshotActivePin, note: pin.note });
      return undefined as T;
    }

    case "screenshot_open_pin_tools": {
      stubScreenshotCall(cmd, args);
      stubPinToolsView = { ...stubPinToolsView, ...args?.view };
      location.hash = "screenshot-pin-tools";
      return `screenshot-tools-${stubActivePinLabel}` as T;
    }

    case "screenshot_pin_tools_init": return { label: stubActivePinLabel, view: { ...stubPinToolsView } } as T;

    case "screenshot_close_pin_tools": {
      if (location.hash === "#screenshot-pin-tools") location.hash = "screenshot-pin";
      return undefined as T;
    }

    case "screenshot_set_pin_note": {
      stubScreenshotCall(cmd, args);
      const note = String(args?.note ?? "").trim().slice(0, 500);
      if (stubScreenshotActivePin) stubScreenshotActivePin.note = note;
      const pin = stubPins.get(stubActivePinLabel); if (pin) pin.note = note;
      return note as T;
    }

    case "screenshot_list_pins":

    case "screenshot_board_pins": return [...stubPins].map(([label, pin]) => ({ label, ...pin })) as T;

    case "screenshot_arrange_pins": {
      stubScreenshotCall(cmd, args);
      if (new URLSearchParams(location.search).get("qaPinBoard") === "1") location.hash = "screenshot-pin-board";
      return stubPins.size as T;
    }

    case "screenshot_pins_batch": {
      stubScreenshotCall(cmd, args);
      const count = stubPins.size;
      if (args?.action === "closeAll") { stubPins.clear(); location.hash = ""; }
      else { const { emit } = await import("../tauri-event"); await emit("screenshot://pin-action", { action: args?.action }); }
      return count as T;
    }

    case "screenshot_focus_pin": stubScreenshotCall(cmd, args); return undefined as T;

    case "screenshot_edit_pin": {
      stubScreenshotCall(cmd, args); stubScreenshotDocument = true; location.hash = "screenshot-overlay"; return undefined as T;
    }

    case "screenshot_open_editor": {
      stubScreenshotCall(cmd, args); return "stub-external-working-copy.png" as T;
    }

    case "screenshot_list_favorites": {
      stubScreenshotCall(cmd, args);
      const fault = new URLSearchParams(location.search).get("qaScreenshotFavoritesError");
      if (stubScreenshotFavoritesFails(fault)) throw new Error("Screenshot favorites storage unavailable");
      return screenshotFavorites().map(({ dataUrl: _dataUrl, ...item }) => item) as T;
    }

    case "screenshot_add_favorite": {
      stubScreenshotCall(cmd, args);
      const path = String((args as { path: string }).path);
      const dataUrl = stubScreenshotFiles.get(path) ?? path;
      const item: StubScreenshotFavorite = { id: crypto.randomUUID(), ...await screenshotImageSize(dataUrl), createdAt: Date.now(), dataUrl, note: stubScreenshotActivePin?.note ?? "" };
      localStorage.setItem(STUB_SCREENSHOT_FAVORITES, JSON.stringify([item, ...screenshotFavorites()]));
      const { dataUrl: _dataUrl, ...info } = item;
      return info as T;
    }

    case "screenshot_remove_favorite": {
      stubScreenshotCall(cmd, args);
      const id = (args as { id: string }).id;
      localStorage.setItem(STUB_SCREENSHOT_FAVORITES, JSON.stringify(screenshotFavorites().filter((item) => item.id !== id)));
      return undefined as T;
    }

    case "screenshot_favorite_thumbnail": {
      const item = screenshotFavorites().find((item) => item.id === (args as { id: string }).id);
      if (!item) throw new Error("Screenshot favorite unavailable");
      return item.dataUrl as T;
    }

    case "screenshot_pin_favorite": {
      stubScreenshotCall(cmd, args);
      const item = screenshotFavorites().find((item) => item.id === (args as { id: string }).id);
      if (!item) throw new Error("Screenshot favorite unavailable");
      stubScreenshotActivePin = { path: item.dataUrl, width: item.width, height: item.height, favoriteId: item.id, note: item.note ?? "" };
      stubActivePinLabel = `screenshot-pin-${++stubPinSequence}`;
      stubPins.set(stubActivePinLabel, { ...stubScreenshotActivePin, note: item.note ?? "", order: stubPinSequence });
      location.hash = "screenshot-pin";
      return "screenshot-pin-1" as T;
    }

    case "screenshot_ocr": {
      stubScreenshotCall(cmd, args);
      return ({ text: "Taomni stub OCR\nuser@example.com", langs: "eng" } as unknown) as T;
    }

    case "screenshot_auto_redact": {
      stubScreenshotCall(cmd, args);
      return ({ boxes: [{ x: 10, y: 10, w: 60, h: 20, kind: "email" }], count: 1 } as unknown) as T;
    }

    case "screenshot_probe": {
      return ({
        permission: "notRequired",
        controlPermission: "notRequired",
        mp4Available: true,
        ocrAvailable: false,
        summary: "browser stub",
      } as unknown) as T;
    }

    case "screenshot_start_recording": {
      stubScreenshotCall(cmd, args);
      location.hash = "screenshot-recorder";
      return ({ recordingId: "stub-rec-1" } as unknown) as T;
    }

    case "screenshot_stop_recording": {
      stubScreenshotCall(cmd, args);
      return ({ path: STUB_SCREENSHOT_DATA_URL, width: 400, height: 300, frames: 30, durationMs: 3000 } as unknown) as T;
    }

    case "screenshot_cancel_recording":

    case "screenshot_current_recording": {
      stubScreenshotCall(cmd, args);
      return (cmd === "screenshot_current_recording" ? ("stub-rec-1" as unknown) : (undefined as unknown)) as T;
    }

    case "screenshot_shortcut_status":

    case "screenshot_shortcut_set": {
      stubScreenshotCall(cmd, args);
      throw new Error("global shortcuts are native-only");
    }
    default: throw new Error(`Unhandled screenshot stub command: ${cmd}`);
  }
}
