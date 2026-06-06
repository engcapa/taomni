import "@testing-library/jest-dom/vitest";
import { createElement, forwardRef, useImperativeHandle, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { vi } from "vitest";

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
