export type CloseRequestedEvent = {
  preventDefault: () => void;
};

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
    return undefined;
  }

  async startResizeDragging(_direction: string): Promise<void> {
    return undefined;
  }

  async minimize(): Promise<void> {
    return undefined;
  }

  async toggleMaximize(): Promise<void> {
    return undefined;
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
