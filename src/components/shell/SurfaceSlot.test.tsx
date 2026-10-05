import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ShellSurfaceRegistry, StableSurface, SurfaceSlot } from "./SurfaceSlot";

describe("Stable business surface", () => {
  it("keeps the new host registered when an old host with the same identity leaves", () => {
    function Stage({ bottom }: { bottom: boolean }) { return <ShellSurfaceRegistry><div>{bottom && <SurfaceSlot id="panel:files" />}</div><div>{!bottom && <SurfaceSlot id="panel:files" />}</div><StableSurface id="files" slot="panel:files" visible><input aria-label="moved draft" defaultValue="initial" /></StableSurface></ShellSurfaceRegistry>; }
    const view = render(<Stage bottom={false} />);
    const input = screen.getByLabelText("moved draft");
    fireEvent.change(input, { target: { value: "retained" } });
    view.rerender(<Stage bottom />);
    expect(screen.getByLabelText("moved draft")).toBe(input);
    expect(input).toHaveValue("retained");
    expect(input.closest('[data-slot-id="panel:files"]')).toBeInTheDocument();
  });
  it("keeps one controller and its DOM draft when hidden and moved", () => {
    const mounted = vi.fn();
    function Business() { useState(() => { mounted(); return null; }); return <input aria-label="draft" defaultValue="initial" />; }
    function Stage({ slot, visible }: { slot: string; visible: boolean }) { return <ShellSurfaceRegistry><SurfaceSlot id="right" /><SurfaceSlot id="bottom" /><StableSurface id="files" slot={slot} visible={visible}><Business /></StableSurface></ShellSurfaceRegistry>; }
    const view = render(<Stage slot="right" visible />);
    const input = screen.getByLabelText("draft"); fireEvent.change(input, { target: { value: "retained draft" } });
    view.rerender(<Stage slot="right" visible={false} />); expect(input.closest('[data-surface-id="files"]')).toHaveAttribute("aria-hidden", "true");
    view.rerender(<Stage slot="bottom" visible />); expect(screen.getByLabelText("draft")).toBe(input); expect(input).toHaveValue("retained draft");
    expect(input.closest('[data-slot-id="bottom"]')).not.toBeNull(); expect(mounted).toHaveBeenCalledTimes(1);
  });
  it("restores visibility before notifying retained views to measure their size", () => {
    function Stage({ visible }: { visible: boolean }) { return <ShellSurfaceRegistry><SurfaceSlot id="work" /><StableSurface id="business" slot="work" visible={visible}><input aria-label="measured draft" defaultValue="retained" /></StableSurface></ShellSurfaceRegistry>; }
    const view = render(<Stage visible={false} />);
    const input = screen.getByLabelText("measured draft");
    const resize = vi.fn(() => screen.queryByRole("textbox", { name: "measured draft" }));
    window.addEventListener("resize", resize);
    try {
      view.rerender(<Stage visible />);
      expect(resize).toHaveBeenCalledTimes(1);
      expect(resize.mock.results[0].value).toBe(input);
      expect(screen.getByLabelText("measured draft")).toBe(input);
      expect(input).toHaveValue("retained");
    } finally { window.removeEventListener("resize", resize); }
  });
});
