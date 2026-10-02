export type CloseRequestedEvent = {
  preventDefault: () => void;
};

class MockWindow {
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
