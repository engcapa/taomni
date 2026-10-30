import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as panels from "react-resizable-panels";

vi.unmock("react-resizable-panels");

import { installPanelResizeHarness, mountPanelResizeFixture } from "./resizablePanelsResizeHarness";

// Node resolves the package's CJS main; Vite builds use its ESM module. Exercise
// both shipped entry points so the dependency patch cannot drift between them.
const esmEntry = "react-resizable-panels/dist/react-resizable-panels.js";
const esmPanels: typeof panels = await import(esmEntry);

describe.each([{ entry: "CJS", components: panels }, { entry: "ESM", components: esmPanels }])(
  "real resizable panels observer ownership ($entry)", ({ components }) => {
    const mountFixture = (nested = false, syncVisibility = false) => mountPanelResizeFixture(nested, components, syncVisibility);
    let clock: ReturnType<typeof installPanelResizeHarness>;
    beforeEach(() => { clock = installPanelResizeHarness(); });
    afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

    it("retains a closed percentage default before geometry and across hidden restoration", () => {
      const fixture = mountPanelResizeFixture(false, components, false, true);
      const docs = fixture.container.querySelector<HTMLElement>('[id="docs"]')!;
      expect(fixture.docsRef.current!.isCollapsed()).toBe(true);
      expect(Number.parseFloat(docs.style.flexGrow)).toBe(0);
      expect(fixture.onResize).not.toHaveBeenCalled();
      for (const width of [1000, 0, 1200]) {
        fixture.setWidth(width);
        fixture.deliver();
        expect(Number.parseFloat(docs.style.flexGrow)).toBe(0);
        clock.flushFrame();
        expect(fixture.docsRef.current!.isCollapsed()).toBe(true);
        expect(Number.parseFloat(docs.style.flexGrow)).toBe(0);
      }
      act(() => fixture.docsRef.current!.expand());
      expect(fixture.docsRef.current!.isCollapsed()).toBe(false);
      expect(fixture.docsRef.current!.getSize().inPixels).toBeCloseTo(185, 1);
      act(() => fixture.docsRef.current!.collapse());
      expect(Number.parseFloat(docs.style.flexGrow)).toBe(0);
    });

    it("defers hidden-to-visible layout publication and panel callbacks beyond observer delivery", () => {
      const fixture = mountFixture();
      const initial = fixture.groupRef.current!.getLayout();
      fixture.setWidth(1000);
      fixture.deliver();
      expect(fixture.reads).not.toHaveBeenCalled();
      expect(fixture.groupRef.current!.getLayout()).toEqual(initial);
      expect(fixture.onResize).not.toHaveBeenCalled();
      expect(clock.frames.size).toBe(1);
      clock.flushFrame();
      expect(fixture.groupRef.current!.getLayout().docs * 10).toBeCloseTo(235, 1);
      expect(fixture.onResize).toHaveBeenCalledTimes(2);
      expect(fixture.onLayoutChange).toHaveBeenCalled();
      expect(fixture.onLayoutChanged).toHaveBeenLastCalledWith(expect.any(Object), { isUserInteraction: false });
    });

    it("coalesces deliveries and reads current geometry instead of the stale notification size", () => {
      const fixture = mountFixture();
      fixture.setWidth(1000);
      fixture.deliver();
      fixture.setWidth(1200);
      fixture.deliver();
      expect(clock.frames.size).toBe(1);
      clock.flushFrame();
      expect(fixture.groupRef.current!.getLayout().docs * 12).toBeCloseTo(235, 1);
      expect(fixture.onResize).toHaveBeenCalledTimes(2);
      expect(fixture.onResize.mock.calls[1][0].inPixels).toBeCloseTo(240, 1);
    });

    it("preserves fixed pixel constraints and nested split layouts across three hidden restores", () => {
      const fixture = mountFixture(true);
      fixture.setWidth(1000);
      fixture.deliver();
      fixture.deliver("resize-nested");
      clock.flushFrame();
      act(() => fixture.nestedRef.current!.setLayout({ left: 65, right: 35 }));
      const split = fixture.nestedRef.current!.getLayout();
      for (const width of [800, 1200, 900]) {
        const before = fixture.groupRef.current!.getLayout();
        fixture.setWidth(0);
        fixture.deliver();
        fixture.deliver("resize-nested");
        clock.flushFrame();
        expect(fixture.groupRef.current!.getLayout()).toEqual(before);
        fixture.setWidth(width);
        fixture.deliver();
        fixture.deliver("resize-nested");
        clock.flushFrame();
        expect(fixture.groupRef.current!.getLayout().docs * width / 100).toBeCloseTo(235, 1);
        expect(fixture.nestedRef.current!.getLayout()).toEqual(split);
      }
    });

    it("keeps imperative collapse, expand and resize immediate while an observer frame is pending", () => {
      const fixture = mountFixture();
      fixture.setWidth(1000);
      fixture.deliver();
      clock.flushFrame();
      fixture.setWidth(1200);
      fixture.deliver();
      act(() => fixture.docsRef.current!.collapse());
      expect(fixture.docsRef.current!.isCollapsed()).toBe(true);
      clock.flushFrame();
      expect(fixture.docsRef.current!.isCollapsed()).toBe(true);
      act(() => fixture.docsRef.current!.expand());
      expect(fixture.docsRef.current!.isCollapsed()).toBe(false);
      act(() => fixture.docsRef.current!.resize(250));
      expect(fixture.groupRef.current!.getLayout().docs * 12).toBeCloseTo(250, 1);
    });

    it("commits visible tool geometry before paint without waiting for an observer frame", () => {
      const fixture = mountFixture(true, true);
      fixture.setWidth(1000);
      fixture.deliver();
      fixture.deliver("resize-nested");
      clock.flushFrame();
      const split = fixture.nestedRef.current!.getLayout();
      const content = fixture.container.querySelector('[id="docs"]');
      for (let cycle = 0; cycle < 3; cycle++) {
        fixture.setOpen(false);
        expect(fixture.docsRef.current!.isCollapsed()).toBe(true);
        fixture.setOpen(true);
        expect(fixture.groupRef.current!.getLayout().docs).toBeCloseTo(20, 1);
        expect(fixture.nestedRef.current!.getLayout()).toEqual(split);
        expect(fixture.container.querySelector('[id="docs"]')).toBe(content);
      }
    });

    it("applies pending visible geometry before the first keyboard resize", () => {
      const fixture = mountFixture();
      fixture.setWidth(1000);
      fixture.deliver();
      const separator = fixture.container.querySelector<HTMLElement>("[data-separator]")!;
      fireEvent.keyDown(separator, { key: "ArrowLeft" });
      expect(clock.frames.size).toBe(0);
      expect(fixture.groupRef.current!.getLayout().docs * 10).toBeCloseTo(285, 1);
      expect(fixture.onLayoutChanged).toHaveBeenLastCalledWith(expect.any(Object), { isUserInteraction: true });
    });

    it("cancels pending frames and ignores a queued notification after unmount", () => {
      const fixture = mountFixture();
      fixture.setWidth(1000);
      const observer = fixture.observer("resize-root");
      const entries = observer.entries();
      fixture.deliver();
      const pendingFrame = [...clock.frames.values()][0];
      fixture.unmount();
      expect(observer.disconnected).toBe(true);
      expect(clock.frames.size).toBe(0);
      act(() => observer.deliver(entries));
      expect(clock.frames.size).toBe(0);
      fixture.reads.mockClear();
      act(() => pendingFrame(performance.now()));
      expect(fixture.reads).not.toHaveBeenCalled();
      clock.flushFrame();
      expect(fixture.onResize).not.toHaveBeenCalled();
    });
  },
);
