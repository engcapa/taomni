export type CloseRequestedEvent = {
  preventDefault: () => void;
};

type WindowAction = "startDragging" | "toggleMaximize";
const windowActions: WindowAction[] = [];
declare global {
  interface Window { readonly __taomniWindowActions: readonly WindowAction[] }
}
// Browser-preview observations only: the desktop build imports Tauri instead.
// Return a copy so tests can inspect real gesture dispatch without changing it.
Object.defineProperty(window, "__taomniWindowActions", { configurable: true, get: () => [...windowActions] });
function recordWindowAction(action: WindowAction) {
  windowActions.push(action);
  if (windowActions.length > 128) windowActions.shift();
}

class MockWindow {
  get label(): string { return location.hash.startsWith("#screenshot-pin") ? "screenshot-pin-1" : "main"; }
  async innerSize(): Promise<{ width: number; height: number }> {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  async scaleFactor(): Promise<number> { return 1; }
  async setResizable(_resizable: boolean): Promise<void> { return undefined; }
  async onCloseRequested(_handler: (event: CloseRequestedEvent) => void | Promise<void>): Promise<() => void> {
    return () => {};
  }

  async startDragging(): Promise<void> {
    recordWindowAction("startDragging");
  }

  async startResizeDragging(_direction: string): Promise<void> {
    return undefined;
  }

  async minimize(): Promise<void> {
    return undefined;
  }

  async toggleMaximize(): Promise<void> {
    recordWindowAction("toggleMaximize");
  }

  async close(): Promise<void> {
    if (location.hash === "#screenshot-pin-tools") {
      const { emit } = await import("./tauri-event");
      await emit("screenshot://pin-tool", { action: "toolsClosed" });
      location.hash = "screenshot-pin";
    }
    return undefined;
  }

  async hide(): Promise<void> {
    return undefined;
  }

  async show(): Promise<void> {
    return undefined;
  }

  async setFocus(): Promise<void> {
    return undefined;
  }

  async setSize(_size: LogicalSize): Promise<void> {
    return undefined;
  }
}

export class LogicalSize {
  constructor(
    public width: number,
    public height: number,
  ) {}
}

const mockWindow = new MockWindow();

export function getCurrentWindow(): MockWindow {
  return mockWindow;
}

export function appWindow(): MockWindow {
  return mockWindow;
}
