import "@testing-library/jest-dom/vitest";
import { createElement, forwardRef, useImperativeHandle, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { vi } from "vitest";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string) => ({
      svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 120 40"><text x="4" y="20">diagram</text></svg>`,
    })),
  },
}));

type MockPanelHandle = {
  collapse: () => void;
  expand: () => void;
  getSize: () => { asPercentage: number; inPixels: number };
  isCollapsed: () => boolean;
  resize: (size: number | string) => void;
};

vi.mock("react-resizable-panels", () => {
  const Group = ({ children, className }: { children?: ReactNode; className?: string }) => (
    createElement("div", { className, "data-group": true, "data-testid": "panel-group" }, children)
  );
  const Panel = forwardRef<MockPanelHandle, { children?: ReactNode; className?: string; panelRef?: Ref<MockPanelHandle | null> }>(
    ({ children, className, panelRef }, ref) => {
      const handle: MockPanelHandle = {
        collapse: vi.fn(),
        expand: vi.fn(),
        getSize: vi.fn(() => ({ asPercentage: 50, inPixels: 500 })),
        isCollapsed: vi.fn(() => false),
        resize: vi.fn(),
      };
      useImperativeHandle(ref, () => handle);
      useImperativeHandle(panelRef, () => handle);
      return createElement("div", { className, "data-panel": true, "data-testid": "panel" }, children);
    },
  );
  const Separator = ({ className, "data-testid": testId }: HTMLAttributes<HTMLDivElement> & { "data-testid"?: string }) => (
    createElement("div", { className, "data-separator": true, "data-testid": testId ?? "panel-resize-handle" })
  );

  return {
    Group,
    Panel,
    Separator,
    PanelGroup: Group,
    PanelResizeHandle: Separator,
    useDefaultLayout: () => ({
      defaultLayout: undefined,
      onLayoutChange: undefined,
      onLayoutChanged: undefined,
    }),
  };
});

if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", {
    value: {
      randomUUID: () => `test-${Math.random().toString(16).slice(2)}`,
    },
  });
}

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
  })) as unknown as HTMLCanvasElement["getContext"];
  HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
    callback(new Blob([""], { type: "image/png" }));
  }) as unknown as HTMLCanvasElement["toBlob"];
}

if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = vi.fn(() => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  })) as unknown as Range["getClientRects"];
  Range.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({}),
  })) as unknown as Range["getBoundingClientRect"];
}
